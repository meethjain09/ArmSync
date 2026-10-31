# Dual-Board Web-Controlled 4-DOF Robotic Arm

An end-to-end IoT and robotics system featuring real-time kinematic teleoperation, autonomous reflex routines, and computer vision classification. The system is engineered around a decoupled **Dual-Board Architecture** to eliminate network packet congestion, deliver deterministic sub-15ms joint actuation, and sustain high-framerate MJPEG video streaming.

---

## Table of Contents
- [Project Overview](#project-overview)
- [Three-Tier Operating Modes](#three-tier-operating-modes)
- [Dual-Board System Architecture](#dual-board-system-architecture)
  - [1. The Muscle: ESP8266 NodeMCU V3](#1-the-muscle-esp8266-nodemcu-v3)
  - [2. The Eyes: AI-Thinker ESP32-CAM](#2-the-eyes-ai-thinker-esp32-cam)
  - [3. The Brain: Python FastAPI Bridge](#3-the-brain-python-fastapi-bridge)
  - [4. The Command Center: React Web Dashboard](#4-the-command-center-react-web-dashboard)
- [Hardware Setup & Power Delivery](#hardware-setup--power-delivery)
  - [Power Domain & Common Ground](#power-domain--common-ground)
  - [Pinout Mapping](#pinout-mapping)
  - [Flashing Circuit for ESP32-CAM](#flashing-circuit-for-esp32-cam)
- [Installation & Execution Guide](#installation--execution-guide)
  - [Step 1: Flash Embedded Microcontrollers](#step-1-flash-embedded-microcontrollers)
  - [Step 2: Configure & Start Python FastAPI Brain](#step-2-configure--start-python-fastapi-brain)
  - [Step 3: Launch React Command Dashboard](#step-3-launch-react-command-dashboard)
  - [Step 4: Optional Tier 1C Vision Sorter](#step-4-optional-tier-1c-vision-sorter)
- [API Contract & JSON Protocol](#api-contract--json-protocol)
- [Safety Mechanisms](#safety-mechanisms)
- [Hybrid Deployment Guide (Vercel + Local Presentation Laptop)](#hybrid-deployment-guide-vercel--local-presentation-laptop)
  - [1. Deploy React Frontend to Vercel](#1-deploy-react-frontend-to-vercel)
  - [2. Run Python FastAPI Brain Locally](#2-run-python-fastapi-brain-locally)
  - [3. Dynamic In-App Settings & Network Configuration](#3-dynamic-in-app-settings--network-configuration)
  - [4. Handling Browser Mixed Content Policies](#4-handling-browser-mixed-content-policies)

---

## Project Overview

This project implements a precision 4-DOF (Degrees of Freedom) articulated robotic arm designed for remote industrial and laboratory teleoperation. By offloading heavy camera frame encoding to a dedicated wireless vision node and running hardware kinematics on a separate microcontroller, the arm achieves smooth motion profiles without Brownout Resets (BOR) or servo jitter.

### Three-Tier Operating Modes
- **Tier 1A: Manual Control**  
  Direct, low-latency joint actuation over full-duplex WebSockets with live visual targeting, soft kinematic limits, and one-click pose presets.
- **Tier 1B: Sense & Place (Autonomous Proximity Reflex)**  
  Event-driven reflex automation. When the ultrasonic sensor detects an obstacle within `< 10cm`, the FastAPI brain triggers an autonomous 7-step pick-and-place kinematic trajectory.
- **Tier 1C: Vision Sorting (Edge AI)**  
  Real-time shape detection (Cube, Sphere, Pyramid) powered by OpenCV and YOLOv8 with confidence gating (>85%) that routes classified objects into designated physical sorting bins.

---

## Dual-Board System Architecture

```
                                  +---------------------------------------+
                                  |         React Web Dashboard           |
                                  |          (Port 3000 / Vite)           |
                                  +---------------------------------------+
                                        /                           \
               WebSocket JSON (/ws)    /                             \   HTTP MJPEG Stream
               Kinematics & Telemetry /                               \  (Port 81 /stream)
                                     v                                 v
                 +-----------------------+                 +-----------------------+
                 |  Python FastAPI Brain |                 |   Board 2: The Eyes   |
                 |      (Port 8000)      |                 |   AI-Thinker ESP32    |
                 +-----------------------+                 |     (192.168.1.102)   |
                             |                             +-----------------------+
                             | WebSocket (Port 82)                     |
                             v                                    OV2640 Sensor
                 +-----------------------+                     (25-30 FPS @ VGA)
                 |   Board 1: The Muscle |
                 |     ESP8266 NodeMCU   |
                 |     (192.168.1.101)   |
                 +-----------------------+
                   /         |         \
         4x MG90 Servos   HC-SR04   Motion Smoothing
          (PWM D1,D2,D5,D6) Sonar   (15ms Interp)
```

### 1. The Muscle: ESP8266 NodeMCU V3
- **Role:** Dedicated kinematics actuator and telemetry transducer.
- **Firmware:** `firmware/esp8266_robotic_arm.ino`
- **Network Interface:** Hosts a WebSocket Server on **Port 82**.
- **Features:**
  - Non-blocking 15ms cooperative servo interpolation loop (1° per tick) preventing mechanical backlash and current spikes.
  - Periodic ultrasonic distance broadcast (5Hz / 200ms).
  - Strict unified JSON parser enforcing full 4-axis motion bounds.

### 2. The Eyes: AI-Thinker ESP32-CAM
- **Role:** Dedicated standalone wireless camera transmitter.
- **Firmware:** `firmware/esp32_cam_video_only.ino`
- **Network Interface:** Hosts an asynchronous HTTP MJPEG stream on **Port 81** (`/stream`).
- **Features:**
  - Zero servo or WebSocket code executed on this chip, dedicating 100% of CPU and DMA channels to camera frame acquisition.
  - Automatic PSRAM detection adjusting buffer depth (VGA 640x480 with double buffering).

### 3. The Brain: Python FastAPI Bridge
- **Role:** Central state manager, mode coordinator, and pass-through routing engine.
- **Entry Point:** `server.py` (Port 8000)
- **Features:**
  - Connects out to NodeMCU Port 82 while accepting browser clients on `/ws`.
  - Coordinates Tier 1B autonomous state machine transitions.
  - Exposes REST endpoints for kinematics dispatch (`/api/move`), manual E-Stop (`/api/estop`), and vision logs (`/api/sort-logs`).

### 4. The Command Center: React Web Dashboard
- **Role:** Zero-install teleoperation interface built with React 19, TypeScript, and Tailwind CSS.
- **Features:**
  - Pinned, high-contrast Emergency Stop button.
  - Real-time 4-axis joint control sliders with integer coercion.
  - Live MJPEG stream embed with HUD targeting reticle.
  - Dual visual themes: Deep Space Obsidian and Clean Industrial Laboratory White.

---

## Hardware Setup & Power Delivery

### Power Domain & Common Ground
> **CRITICAL:** Standard USB ports provide 500mA–1A, which will cause brownout resets when multiple servos articulate simultaneously.

1. **Power Supply:** Use a dedicated external DC power supply (e.g., 12V 3A adapter or 2S/3S LiPo) stepped down through an **LM2596 Buck Converter** tuned to exactly **5.0V DC** (capable of 3A sustained).
2. **Servo Bus:** Wire the positive (`+`) power leads of all 4x MG90 micro servos directly to the LM2596 5V output.
3. **Common Ground:** Tie the `GND` of the LM2596 buck converter, the NodeMCU `GND`, and the ESP32-CAM `GND` together. A shared ground reference is required for clean PWM signal timing.

```
[ External 12V PSU ] ---> [ LM2596 Buck Converter (5V 3A) ]
                                |              |
                                | (+5V Rail)   | (GND Rail - COMMON GROUND)
                                v              v
                         4x MG90 Servos   +----+----+----+
                                          |    |    |    |
                                       Servos Node  CAM  PSU
```

### Pinout Mapping

#### Board 1: NodeMCU V3 (The Muscle)
| Component | NodeMCU Pin | ESP8266 GPIO | Signal Type | Electrical / Functional Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Base Servo** | `D1` | GPIO 5 | PWM Output | Azimuth rotation (0° to 180°) |
| **Shoulder Servo** | `D2` | GPIO 4 | PWM Output | Vertical elevation joint |
| **Elbow Servo** | `D5` | GPIO 14 | PWM Output | Forearm pitch joint |
| **Gripper Servo** | `D6` | GPIO 12 | PWM Output | End-effector jaw (30° Open, 90° Closed) |
| **HC-SR04 TRIG** | `D0` | GPIO 16 | Digital Output | 10µs ultrasonic trigger pulse |
| **HC-SR04 ECHO** | `D7` | GPIO 13 | Digital Input | 5V-tolerant input pin on NodeMCU |

#### Board 2: AI-Thinker ESP32-CAM (The Eyes)
| Component | ESP32 Pin | Function | Notes |
| :--- | :--- | :--- | :--- |
| **OV2640 Bus** | GPIO 0, 2, 4, 5, 18, 19, 21, 22, 23, 25, 26, 27, 32, 34-36, 39 | Camera Data & Clocks | Standard AI-Thinker ribbon pinout |
| **VCC** | `5V` | Power In | Connect to clean 5V supply |
| **GND** | `GND` | Ground Reference | Common ground with system |

### Flashing Circuit for ESP32-CAM
Because the AI-Thinker ESP32-CAM lacks an onboard USB-to-UART chip:
1. Connect a **CP2102** (or FTDI) USB-to-Serial adapter:
   - `CP2102 TX` &rarr; `ESP32-CAM U0R (GPIO 3)`
   - `CP2102 RX` &rarr; `ESP32-CAM U0T (GPIO 1) `
   - `CP2102 5V` &rarr; `ESP32-CAM 5V`
   - `CP2102 GND` &rarr; `ESP32-CAM GND`
2. **Flash Mode Jumper:** Connect a jumper wire between **`GPIO 0` and `GND`** on the ESP32-CAM before plugging in the USB adapter.
3. Once the upload finishes in the Arduino IDE, disconnect the `GPIO 0` to `GND` jumper and press the onboard **RST** button to start normal execution.

---

## Installation & Execution Guide

### Prerequisites
- **Arduino IDE 2.x** with ESP8266 and ESP32 board definitions installed.
- **Python 3.10+**
- **Node.js 18+** and **npm**

---

### Step 1: Flash Embedded Microcontrollers

#### 1. Flash NodeMCU (`firmware/esp8266_robotic_arm.ino`)
1. Open `firmware/esp8266_robotic_arm.ino` in Arduino IDE.
2. In the code, set your Wi-Fi credentials:
   ```cpp
   const char* WIFI_SSID     = "Your_2.4GHz_SSID";
   const char* WIFI_PASSWORD = "Your_Password";
   ```
3. Select board: **Tools** &rarr; **Board** &rarr; **ESP8266** &rarr; **NodeMCU 1.0 (ESP-12E Module)**.
4. Select your active USB COM port and click **Upload**.
5. Open Serial Monitor at **115200 baud** and record the assigned IP (e.g., `192.168.1.101`).

#### 2. Flash ESP32-CAM (`firmware/esp32_cam_video_only.ino`)
1. Connect ESP32-CAM to your CP2102 adapter with `GPIO 0` jumpered to `GND`.
2. Open `firmware/esp32_cam_video_only.ino` in Arduino IDE.
3. Update `WIFI_SSID` and `WIFI_PASSWORD`.
4. Select board: **Tools** &rarr; **Board** &rarr; **ESP32** &rarr; **AI Thinker ESP32-CAM**.
5. Set:
   - CPU Frequency: `240MHz`
   - Partition Scheme: `Huge APP (3MB No OTA/1MB SPIFFS)`
6. Click **Upload**.
7. Remove the `GPIO 0` jumper, press **RST**, and note the camera IP from the Serial Monitor (e.g., `192.168.1.102`).

---

### Step 2: Configure & Start Python FastAPI Brain

1. Install Python dependencies:
   ```bash
   pip install fastapi uvicorn websockets pydantic requests opencv-python ultralytics scikit-learn matplotlib
   ```

2. Export the NodeMCU IP as `ESP8266_HOST` (or `ESP32_HOST`) and start `server.py`:
   ```bash
   # Linux / macOS
   export ESP8266_HOST="192.168.1.101"
   export ESP8266_WS_PORT="82"
   python server.py

   # Windows (Command Prompt)
   set ESP8266_HOST=192.168.1.101
   set ESP8266_WS_PORT=82
   python server.py

   # Windows (PowerShell)
   $env:ESP8266_HOST="192.168.1.101"
   $env:ESP8266_WS_PORT="82"
   python server.py
   ```
   *The server runs at `http://localhost:8000` and bridges WebSocket traffic on `/ws`.*

---

### Step 3: Launch React Command Dashboard

1. Install npm dependencies:
   ```bash
   npm install
   ```

2. Start the development server:
   ```bash
   npm run dev
   ```

3. Open your browser at `http://localhost:3000`.
4. Click the **Settings (Gear Icon)** in the header:
   - Enter your **ESP32-CAM IP** (e.g., `192.168.1.102`) to bind the video stream at port 81.
   - Verify the **FastAPI WS Bridge** is set to `ws://localhost:8000/ws`.
   - Click **Reconnect & Refresh Video**.

---

### Step 4: Optional Tier 1C Vision Sorter

If running computer vision sorting:
```bash
# In a separate terminal
export ESP32_IP="192.168.1.102"
export FASTAPI_HOST="http://localhost:8000"
python vision_sorter.py
```
To generate formal model evaluation metrics (Confusion Matrix and Precision/Recall benchmarks):
```bash
python evaluate_model.py
```
*Outputs `presentation/confusion_matrix.png` and classification tables.*

---

## API Contract & JSON Protocol

### WebSocket Port 82 (Bi-Directional JSON)

#### 1. Joint Actuation Command (Dashboard &rarr; Hardware)
Dispatched whenever a slider or pose preset changes. Values are strictly constrained between `0` and `180`.
```json
{
  "command": "MOVE",
  "base": 90,
  "shoulder": 90,
  "elbow": 90,
  "gripper": 30
}
```

#### 2. Manual Emergency Stop (Dashboard &rarr; Hardware)
Freezes target joint setpoints to current positions immediately.
```json
{
  "command": "STOP"
}
```

#### 3. Real-Time Telemetry Stream (Hardware &rarr; Dashboard)
Broadcast periodically every 200ms (5Hz).
```json
{
  "distance_cm": 14.8,
  "status": "idle"
}
```
*Possible `status` values: `"idle"`, `"moving"`, `"stopped"`.*

---

## Safety Mechanisms

1. **Non-Blocking 15ms Motion Smoothing:**  
   Servos step toward target angles by 1° every 15ms. This prevents the instantaneous 2.5A+ current surges that cause microcontroller brownouts.
2. **Hardware E-Stop Lockout:**  
   When the Emergency Stop button is clicked, target angles snap to current angles, disengaging further interpolation until a deliberate `"MOVE"` reset is issued.
3. **Safe Mode Transition Handshake:**  
   Switching between Tier 1A, 1B, and 1C sends an immediate `"STOP"` command before changing state to prevent kinematics conflicts between manual and autonomous inputs.
4. **Shared Common Ground & Signal Isolation:**  
   Digital logic (3.3V) and motor power rails (5V) share a common ground reference to eliminate floating voltage drift and PWM jitter.

---

## Hybrid Deployment Guide (Vercel + Local Presentation Laptop)

This project utilizes a **Hybrid Deployment Topology** optimized for competitive hackathons:
- **Cloud Layer:** The React 19 + Vite dashboard is deployed to **Vercel** as a high-performance global Single Page Application (SPA).
- **Edge Layer:** The Python FastAPI Brain runs directly on your **physical presentation laptop** (`0.0.0.0:8000`), bridging commands to the local ESP8266 NodeMCU on Port 82.
- **Dynamic Configuration:** Laptop and hardware IPs change frequently on venue Wi-Fi networks. The React frontend features dynamic in-app URL configuration persisted in `localStorage`.

```
                              +-------------------------------------------+
                              |       Render Static Site (Frontend)       |
                              |   https://roboarm-dashboard.onrender.com  |
                              +-------------------------------------------+
                                             /             \
                   WSS Bi-Directional JSON  /               \  HTTPS MJPEG Video
            wss://roboarm-backend.onrender.com/ws/client     \ https://<cam-id>.ngrok-free.app
                                           /                 \
                                          v                   v
            +-----------------------------------------+   +-----------------------------+
            |      Render Web Service (FastAPI)       |   |      ESP32-CAM (Video)      |
            |     https://roboarm-backend.onrender.com|   |   (Local Port 81 -> Ngrok)  |
            +-----------------------------------------+   +-----------------------------+
                                 |
                                 | WSS Hardware Tunnel
                                 | https://<node-id>.ngrok-free.app
                                 v
            +-----------------------------------------+
            |     ESP8266 NodeMCU V3 (Muscle)         |
            |      (Local Port 82 -> Ngrok)           |
            +-----------------------------------------+
```

### 1. Deploy React Frontend to Vercel

1. **Push Code to GitHub:**
   ```bash
   git add .
   git commit -m "feat: hybrid deployment with dynamic settings"
   git push origin main
   ```

2. **Import Project into Vercel:**
   - Go to [vercel.com/new](https://vercel.com/new) and connect your GitHub repository.
   - **Framework Preset:** Vite
   - **Root Directory:** `./`
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`

3. Click **Deploy**. Your dashboard will be live at `https://<your-project>.vercel.app`.

---

### 2. Run Python FastAPI Brain Locally

On your presentation laptop connected to the same local Wi-Fi router or hotspot as the microcontrollers:

1. **Install Dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

2. **Set Hardware IP & Launch Server:**
   ```bash
   # Set the local IP of your ESP8266 NodeMCU
   export ESP8266_HOST="192.168.1.100"
   export ESP8266_WS_PORT="82"

   # Launch FastAPI server bound to all local network interfaces on Port 8000
   python server.py
   ```
   *Uvicorn starts on `http://0.0.0.0:8000` with fully permissive CORS enabled (`allow_origins=["*"]`), allowing requests from your Vercel domain.*

3. **Find Your Laptop's Local IP Address:**
   - **macOS/Linux:** `ifconfig | grep "inet " | grep -v 127.0.0.1`
   - **Windows:** `ipconfig` (look for IPv4 Address, e.g., `192.168.1.50`)

---

### 3. Dynamic In-App Settings & Network Configuration

When accessing your Vercel frontend from any device (laptop, tablet, phone):

1. Click the **Network Settings** button (gear icon) in the top-right header.
2. Enter your live venue network connection parameters:
   - **FastAPI Brain URL:**
     - If viewing dashboard on the same laptop: `ws://localhost:8000/ws`
     - If viewing dashboard on another device (or phone): `ws://192.168.x.x:8000/ws`
   - **Camera Stream URL:**
     - The local IP of your ESP32-CAM: `http://192.168.x.x:81/stream`
3. Click **Reconnect & Refresh**. The URLs are instantly stored in `localStorage` and will persist across browser reloads.

---

### 4. Handling Browser Mixed Content Policies

Because Vercel serves the web dashboard over secure **HTTPS** (`https://...`), modern browsers enforce strict "Mixed Content" security policies that initially block connections to insecure local network endpoints (`ws://` and `http://`).

#### How to Allow Insecure Content:

1. In your browser (Chrome, Edge, Brave), click the **Site Settings / Lock / Tune icon** to the left of the URL bar (`https://<your-project>.vercel.app`).
2. Click **Site settings**.
3. Scroll down to **Insecure content** and change the setting from *Block (default)* to **Allow**.
4. Return to the dashboard and reload the page.

*Both the local WebSocket telemetry stream and the live camera MJPEG feed will now connect flawlessly without requiring external tunnels or cloud relays.*

