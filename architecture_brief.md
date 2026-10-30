# Architecture & Evaluation Brief
**Project:** Mode-Based Web-Controlled 4-DOF Robotic Arm System  
**Document Classification:** Official Hackathon Technical Specification & Verification Brief  
**Author:** Lead Systems Architect  

---

## 1. System Architecture & Communication Flow

The system employs a decoupled, tri-node distributed architecture designed for minimal latency, deterministic kinematics, and fail-safe autonomy:

```
+-----------------------------------------------------------------------+
|                             TRI-NODE TOPOLOGY                         |
+-----------------------------------------------------------------------+
                                                                         
  [ React Dashboard ] <========== Port 8000 /ws ==========> [ FastAPI Brain ]
   (TypeScript/UI)             (Full Duplex JSON)             (Python Engine)
          |                                                         |
          |  (Port 81 HTTP MJPEG Video Stream)                     | (Port 82 WS)
          +-----------------------+                                 | Bi-directional
                                  |                                 | JSON Payloads
                                  v                                 v
                       +-----------------------------------------------+
                       |              ESP32-CAM Node                   |
                       | - Camera Daemon (Port 81 /stream)             |
                       | - WebSocket Controller (Port 82 /ws)          |
                       | - Hardware Timers / PWM / HC-SR04 Sonar       |
                       +-----------------------------------------------+
```

### Tri-Node Role Separation
1. **ESP32-CAM (Hardware Controller):** Executes real-time, microsecond-accurate PWM pulse generation for 4 MG90 servos, samples the HC-SR04 ultrasonic distance sensor, hosts the MJPEG camera server, and runs a localized safety watchdog.
2. **FastAPI Server (Python Brain):** Orchestrates multi-tier operating modes (`1A` Manual Teleoperation, `1B` Autonomous Sense & Place, and `1C` Computer Vision Sorting), manages state transitions, and brokers WebSocket telemetry between browser clients and microcontrollers.
3. **React Application (Web Dashboard):** Provides zero-install operator teleoperation, real-time video rendering, responsive joint angle controls, live sensor metrics, and an omnipresent emergency stop interface.

### Dual-Port Network Pipeline
To avoid head-of-line blocking and eliminate frame buffering latency on network sockets:
- **Port 81 (HTTP MJPEG Stream):** Dedicated exclusively to high-throughput camera frame transport at `http://<ESP32_IP>:81/stream`. Video streaming runs on a lightweight ESP-IDF HTTP server task with cooperative FreeRTOS yielding (`vTaskDelay`), preventing video transmission bursts from starving the motor control loop.
- **Port 82 (WebSocket Control & Telemetry):** Dedicated to bidirectional, sub-15ms JSON communication at `ws://<ESP32_IP>:82/ws`.
  - **Inbound (Commands):** Joint angle targets (`{"command": "MOVE", "base": X, "shoulder": Y, "elbow": Z, "gripper": G}`) and emergency stop interrupts (`{"command": "STOP"}`).
  - **Outbound (Telemetry):** High-frequency sensor feedback (`{"distance_cm": 15.2, "status": "idle"}`) streamed at 5 Hz (200ms intervals).

---

## 2. Hardware & Software Stack

### Hardware Configuration
- **Compute / Microcontroller:** ESP32-CAM (AI-Thinker module, Dual-core Xtensa 32-bit LX6 @ 240MHz, 520KB SRAM + 4MB external PSRAM).
- **Actuators:** 4x TowerPro MG90 Micro Servos (Metal Geared, 1.8 kg·cm stall torque, 50Hz PWM refresh).
  - *Base (Azimuth rotation):* `GPIO 12`
  - *Shoulder (Elevation angle):* `GPIO 13` *(or alternate non-strapping pin per board layout)*
  - *Elbow (Forearm pitch):* `GPIO 14`
  - *Gripper (End-effector jaw):* `GPIO 15`
- **Sensors:** HC-SR04 Ultrasonic Distance Sensor.
  - *Trigger Pulse:* `GPIO 2` (10µs active pulse)
  - *Echo Return:* `GPIO 13` (Rerouted to eliminate PSRAM conflict; signal passed through a 5V-to-3.3V resistor voltage divider)
- **Power Delivery:** Isolated dual-rail configuration. A dedicated 5V 3.5A external supply powers the servo bus with a common ground (`GND`) tied to the ESP32 to eliminate voltage droop and prevent brownout resets during peak stall currents.

### Software Architecture
- **Embedded Firmware (ESP32 C++):**
  - `esp_camera.h` / `esp_http_server.h`: DMA-driven OV2640 frame capture and multipart streaming.
  - `ESP32Servo`: Hardware-timer-allocated PWM modulation.
  - `WebSocketsServer` (by Links2004): Low-overhead asynchronous WebSocket protocol handling.
  - `ArduinoJson` (v6/v7): Zero-copy JSON serialization and deserialization.
- **Backend Orchestrator (Python 3.10+):**
  - `FastAPI` + `Uvicorn`: Asynchronous REST API and WebSocket bridge server.
  - `websockets`: Persistent duplex communication worker connecting the FastAPI brain to ESP32 Port 82.
  - `OpenCV (cv2)`: Ingestion, decoding, and preprocessing of MJPEG video frames.
  - `Ultralytics YOLOv8` + `scikit-learn`: Real-time object detection, confidence gating (>85%), and statistical classification benchmarks.
- **Frontend Dashboard (TypeScript & React 19):**
  - `React SPA` with `Tailwind CSS`: Modern dark-theme telemetry interface.
  - `Lucide React`: Robotics status, safety, and mode iconography.
  - Throttled input dispatchers (20Hz) ensuring no socket congestion occurs during continuous slider manipulation.

---

## 3. Key Design Decisions & Safety Mechanisms

### Global Persistent Emergency Stop (E-Stop)
- **Design:** Pinned in the dashboard viewport across all operating tabs (`1A`, `1B`, `1C`) as an unmissable, high-contrast control.
- **Protocol:** Instantly broadcasts an out-of-band `{"command": "STOP"}` message over the active WebSocket channel and issues a fallback REST call to `/api/estop`.
- **Hardware Interlock:** The ESP32 immediately overwrites joint target setpoints with their current physical positions (`targetAngle = currentAngle`), freezing pulse updates in the current kinematic pose without sudden mechanical whip.

### 2000ms Watchdog Connection Failsafe
- **Heartbeat Monitor:** A dedicated C++ watchdog monitors the millisecond timestamp `last_ping_time`.
- **Automatic Halt:** If network transmission drops, WiFi disconnects, or the Python backend terminates, exceeding a 2000ms threshold without a valid packet triggers an immediate internal `executeEStop("WATCHDOG_HEARTBEAT_LOSS")`. The system will not accept blind kinematic updates during link loss.

### Safe Mode Switching Protocol
- **State Machine Isolation:** To transition between modes (e.g., from Manual `1A` to Autonomous `1B` or Vision `1C`), the frontend executes a multi-step handshake:
  1. Issues an immediate `{"command": "STOP"}` to freeze all ongoing motion.
  2. Introduces a hardware stabilization window (50ms).
  3. Sends `{"command": "SET_MODE", "mode": "<TARGET_MODE>"}` to the backend.
- This prevents race conditions where manual slider values clash with autonomous trajectory generators.

### Non-Blocking Motion Smoothing
- **Problem Solved:** Instantaneous servo writes (`servo.write(angle)`) produce extreme angular acceleration, mechanical gear backlash, and transient current spikes (>2.5A) that cause microcontroller brownouts.
- **Implementation:** Servos are updated inside a non-blocking 15ms cooperative loop (`updateServos()`). Current joint angles increment or decrement towards their targets by exactly **1 degree per 15 milliseconds**, delivering smooth, predictable arm trajectories with minimal gear fatigue.

---

## 4. Data Disclosure Statement

### Held-Out Evaluation Dataset
- The classification performance metrics (Precision, Recall, F1-Score) and the 3x3 Confusion Matrix reported for Tier 1C (Vision Sorting) were derived using an isolated, held-out test split comprising **15%** of our total physically captured dataset.
- The dataset contains physical geometric artifacts (**Cube**, **Sphere**, and **Pyramid**) photographed from the perspective of the ESP32-CAM under varying lighting intensities, tabletop backgrounds, and angular rotations. No test images were present in the training or validation sets.

### Failover Simulation Overlay
- If the physical ESP32-CAM stream is offline or inaccessible during evaluation or demonstration, the Tier 1C vision engine and web dashboard automatically engage an internal synthetic simulation overlay. This overlay provides simulated bounding boxes, simulated class confidence scores, and mock distance readings to demonstrate full kinematic and UI workflows without disrupting evaluation.
