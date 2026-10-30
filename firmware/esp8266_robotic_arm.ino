/**
 * ============================================================================
 * BOARD 1: THE "MUSCLE" - ESP8266 NodeMCU V3 Firmware
 * ============================================================================
 * Role:
 *   - Dedicated servo pulse generation (4x MG90 servos)
 *   - HC-SR04 ultrasonic sensor sampling
 *   - WebSocket Server on Port 82 for bi-directional JSON control & telemetry
 *   - 2000ms heartbeat safety watchdog (Auto E-Stop on connection loss)
 *   - 15ms non-blocking motion smoothing (1° per tick)
 *
 * Safe Pinout Configuration:
 *   - Base Servo:     D1 (GPIO 5)
 *   - Shoulder Servo: D2 (GPIO 4)
 *   - Elbow Servo:    D5 (GPIO 14)
 *   - Gripper Servo:  D6 (GPIO 12)
 *   - Sensor TRIG:    D0 (GPIO 16)
 *   - Sensor ECHO:    D7 (GPIO 13)
 *
 * Libraries Required:
 *   - ESP8266WiFi.h (Built-in ESP8266 core)
 *   - Servo.h (Built-in)
 *   - WebSocketsServer.h (by Markus Sattler / Links2004)
 *   - ArduinoJson.h (v6 / v7 by Benoit Blanchon)
 * ============================================================================
 */

#include <ESP8266WiFi.h>
#include <Servo.h>
#include <WebSocketsServer.h>
#include <ArduinoJson.h>

// ----------------------------------------------------------------------------
// 1. Wi-Fi Configuration
// ----------------------------------------------------------------------------
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// ----------------------------------------------------------------------------
// 2. Hardware Pinout (ESP8266 Safe Pins avoiding Boot Strapping)
// ----------------------------------------------------------------------------
const int PIN_SERVO_BASE     = D1; // GPIO 5  - Safe I/O
const int PIN_SERVO_SHOULDER = D2; // GPIO 4  - Safe I/O
const int PIN_SERVO_ELBOW    = D5; // GPIO 14 - HSCLK
const int PIN_SERVO_GRIPPER  = D6; // GPIO 12 - HMISO

const int PIN_SENSOR_TRIG    = D0; // GPIO 16 - Output trigger
const int PIN_SENSOR_ECHO    = D7; // GPIO 13 - HMOSI / 5V tolerant input

// ----------------------------------------------------------------------------
// 3. Joint Kinematics & Smoothing Limits
// ----------------------------------------------------------------------------
static const int MIN_ANGLE = 0;
static const int MAX_ANGLE = 180;

struct JointAxis {
  int currentDeg;
  int targetDeg;
};

JointAxis jointBase     = {90, 90};
JointAxis jointShoulder = {90, 90};
JointAxis jointElbow    = {90, 90};
JointAxis jointGripper  = {30, 30}; // Default open position (30°)

Servo motorBase;
Servo motorShoulder;
Servo motorElbow;
Servo motorGripper;

// Motion smoothing rate: 15ms interval per 1-degree step
const unsigned long SMOOTHING_INTERVAL_MS = 15;
unsigned long prevStepMillis = 0;

// ----------------------------------------------------------------------------
// 4. Safety Watchdog & Telemetry Timing
// ----------------------------------------------------------------------------
// Heartbeat timeout: Auto E-Stop if 2000ms elapse without a packet from backend
const unsigned long HEARTBEAT_TIMEOUT_MS = 2000;
unsigned long last_ping_time = 0;
bool isSystemHalted = false;
String armStatus = "idle";

// Ultrasonic telemetry interval: broadcast every 200ms (5Hz)
const unsigned long TELEMETRY_INTERVAL_MS = 200;
unsigned long prevTelemetryMillis = 0;
float currentDistanceCm = -1.0f;

// ----------------------------------------------------------------------------
// 5. WebSocket Server Instance (Port 82)
// ----------------------------------------------------------------------------
WebSocketsServer wsServer(82);

// Forward Declarations
void triggerEmergencyStop(const String& reason);
void updateServos();
void readUltrasonicDistance();
void broadcastTelemetry();
void onWebSocketEvent(uint8_t num, WStype_t type, uint8_t * payload, size_t length);

// ============================================================================
// Setup
// ============================================================================
void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("\n[INIT] Starting ESP8266 Muscle Controller (Servos + Telemetry)...");

  // 1. Initialize ultrasonic sensor pins
  pinMode(PIN_SENSOR_TRIG, OUTPUT);
  pinMode(PIN_SENSOR_ECHO, INPUT);
  digitalWrite(PIN_SENSOR_TRIG, LOW);

  // 2. Attach Servos with standard 544us - 2400us pulses
  motorBase.attach(PIN_SERVO_BASE, 544, 2400);
  motorShoulder.attach(PIN_SERVO_SHOULDER, 544, 2400);
  motorElbow.attach(PIN_SERVO_ELBOW, 544, 2400);
  motorGripper.attach(PIN_SERVO_GRIPPER, 544, 2400);

  // Write safe initial home pose
  motorBase.write(jointBase.currentDeg);
  motorShoulder.write(jointShoulder.currentDeg);
  motorElbow.write(jointElbow.currentDeg);
  motorGripper.write(jointGripper.currentDeg);
  Serial.println("[MOTORS] Servos initialized at neutral pose.");

  // 3. Connect to Wi-Fi
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("[WIFI] Connecting to %s", WIFI_SSID);
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.println("\n[WIFI] Connected successfully!");
  Serial.print("[WIFI] Muscle Node IP Address: ");
  Serial.println(WiFi.localIP());

  // 4. Start WebSocket Server on Port 82
  wsServer.begin();
  wsServer.onEvent(onWebSocketEvent);
  Serial.printf("[WS] Muscle Server listening on ws://%s:82/\n", WiFi.localIP().toString().c_str());

  // Prime watchdog timer
  last_ping_time = millis();
}

// ============================================================================
// Main Non-Blocking Loop
// ============================================================================
void loop() {
  unsigned long now = millis();

  // 1. Service WebSocket protocol events
  wsServer.loop();

  // 2. 2000ms Watchdog Connection Loss Failsafe
  if (!isSystemHalted && (now - last_ping_time > HEARTBEAT_TIMEOUT_MS)) {
    triggerEmergencyStop("WATCHDOG_HEARTBEAT_LOSS");
  }

  // 3. 15ms Motion Smoothing Loop (1-degree incremental interpolation)
  if (!isSystemHalted && (now - prevStepMillis >= SMOOTHING_INTERVAL_MS)) {
    prevStepMillis = now;
    updateServos();
  }

  // 4. 200ms Ultrasonic Sensor Sampling & Telemetry Broadcast
  if (now - prevTelemetryMillis >= TELEMETRY_INTERVAL_MS) {
    prevTelemetryMillis = now;
    readUltrasonicDistance();
    broadcastTelemetry();
  }
}

// ============================================================================
// Non-Blocking Motion Smoothing
// ============================================================================
void updateServos() {
  bool activeMotion = false;

  auto stepJoint = [&](JointAxis &joint, Servo &motor) {
    if (joint.currentDeg < joint.targetDeg) {
      joint.currentDeg++;
      motor.write(joint.currentDeg);
      activeMotion = true;
    } else if (joint.currentDeg > joint.targetDeg) {
      joint.currentDeg--;
      motor.write(joint.currentDeg);
      activeMotion = true;
    }
  };

  stepJoint(jointBase, motorBase);
  stepJoint(jointShoulder, motorShoulder);
  stepJoint(jointElbow, motorElbow);
  stepJoint(jointGripper, motorGripper);

  if (!isSystemHalted) {
    armStatus = activeMotion ? "moving" : "idle";
  }
}

// ============================================================================
// Emergency Stop (E-Stop)
// ============================================================================
void triggerEmergencyStop(const String& reason) {
  isSystemHalted = true;

  // Immediately lock targets to current positions to freeze physical motion
  jointBase.targetDeg     = jointBase.currentDeg;
  jointShoulder.targetDeg = jointShoulder.currentDeg;
  jointElbow.targetDeg    = jointElbow.currentDeg;
  jointGripper.targetDeg  = jointGripper.currentDeg;

  armStatus = "stopped";
  Serial.printf("[SAFETY] E-STOP ENGAGED. Reason: %s\n", reason.c_str());

  // Transmit safety status to backend immediately
  broadcastTelemetry();
}

// ============================================================================
// Ultrasonic Distance Measurement (Bounded Non-Blocking Timeout)
// ============================================================================
void readUltrasonicDistance() {
  digitalWrite(PIN_SENSOR_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_SENSOR_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_SENSOR_TRIG, LOW);

  // 25ms timeout bounds maximum distance to ~4.2m without freezing execution
  unsigned long durationUs = pulseIn(PIN_SENSOR_ECHO, HIGH, 25000);

  if (durationUs > 0) {
    currentDistanceCm = (float)(durationUs * 0.0343 / 2.0);
  } else {
    currentDistanceCm = -1.0f; // Timeout or disconnected
  }
}

// ============================================================================
// Telemetry Broadcaster (Port 82)
// ============================================================================
void broadcastTelemetry() {
  StaticJsonDocument<128> doc;
  if (currentDistanceCm >= 0) {
    doc["distance_cm"] = serialized(String(currentDistanceCm, 1));
  } else {
    doc["distance_cm"] = nullptr;
  }
  doc["status"] = armStatus;

  String output;
  serializeJson(doc, output);
  wsServer.broadcastTXT(output);
}

// ============================================================================
// WebSocket Event Handler (Port 82)
// ============================================================================
void onWebSocketEvent(uint8_t num, WStype_t type, uint8_t * payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.printf("[WS] Client #%u connected\n", num);
      last_ping_time = millis(); // Refresh watchdog on connection
      break;

    case WStype_DISCONNECTED:
      Serial.printf("[WS] Client #%u disconnected\n", num);
      break;

    case WStype_TEXT: {
      // 1. Refresh watchdog timer on any valid incoming payload
      last_ping_time = millis();

      // 2. Parse JSON Command
      StaticJsonDocument<256> doc;
      DeserializationError err = deserializeJson(doc, payload, length);
      if (err) return;

      const char* command = doc["command"];
      if (!command) return;

      // Emergency Stop
      if (strcmp(command, "STOP") == 0) {
        triggerEmergencyStop("CLIENT_COMMAND");
        return;
      }

      // Joint Movement Command
      if (strcmp(command, "MOVE") == 0) {
        if (isSystemHalted) {
          isSystemHalted = false;
          Serial.println("[SAFETY] Motion resumed via valid MOVE command.");
        }

        if (doc.containsKey("base")) {
          int target = doc["base"];
          jointBase.targetDeg = constrain(target, MIN_ANGLE, MAX_ANGLE);
        }
        if (doc.containsKey("shoulder")) {
          int target = doc["shoulder"];
          jointShoulder.targetDeg = constrain(target, MIN_ANGLE, MAX_ANGLE);
        }
        if (doc.containsKey("elbow")) {
          int target = doc["elbow"];
          jointElbow.targetDeg = constrain(target, MIN_ANGLE, MAX_ANGLE);
        }
        if (doc.containsKey("gripper")) {
          int target = doc["gripper"];
          jointGripper.targetDeg = constrain(target, MIN_ANGLE, MAX_ANGLE);
        }
      }
      break;
    }
    default:
      break;
  }
}
