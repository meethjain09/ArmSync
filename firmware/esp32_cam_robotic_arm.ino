/**
 * ============================================================================
 * ESP32-CAM 4-DOF Robotic Arm Firmware (Updated with Safe Pinout)
 * ============================================================================
 * Hardware:
 *   - ESP32-CAM (AI-Thinker module)
 *   - 4x MG90 Micro Servos (Base, Shoulder, Elbow, Gripper)
 *   - 1x HC-SR04 Ultrasonic Distance Sensor
 *
 * Network Architecture:
 *   - Port 81: HTTP MJPEG Video Stream (/stream)
 *   - Port 82: WebSocket Server for bi-directional telemetry and joint control
 * ============================================================================
 */

#include "esp_camera.h"
#include <WiFi.h>
#include <ESP32Servo.h>
#include <WebSocketsServer.h>
#include <ArduinoJson.h>
#include "esp_http_server.h"

// ----------------------------------------------------------------------------
// 1. Wi-Fi Configuration
// ----------------------------------------------------------------------------
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// ----------------------------------------------------------------------------
// 2. Pinout Definitions (Updated to avoid GPIO 16 PSRAM conflict)
// ----------------------------------------------------------------------------
#define PIN_SERVO_BASE     12
#define PIN_SERVO_SHOULDER 13
#define PIN_SERVO_ELBOW    14
#define PIN_SERVO_GRIPPER  15

#define PIN_SENSOR_TRIG    2
#define PIN_SENSOR_ECHO    4   // Moved from GPIO 16 (which conflicts with onboard PSRAM CS)

// AI-Thinker Camera Pinout
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

// ----------------------------------------------------------------------------
// 3. Kinematic Joint Limits & Motion Smoothing Constants
// ----------------------------------------------------------------------------
static const int MIN_ANGLE = 0;
static const int MAX_ANGLE = 180;

struct JointState {
  int currentAngle;
  int targetAngle;
};

JointState jointBase     = {90, 90};
JointState jointShoulder = {90, 90};
JointState jointElbow    = {90, 90};
JointState jointGripper  = {90, 90};

Servo servoBase;
Servo servoShoulder;
Servo servoElbow;
Servo servoGripper;

const unsigned long STEP_INTERVAL_MS = 15;
unsigned long lastStepTime = 0;

// ----------------------------------------------------------------------------
// 4. Safety & Watchdog Timers
// ----------------------------------------------------------------------------
const unsigned long HEARTBEAT_TIMEOUT_MS = 2000;
unsigned long last_ping_time = 0;
bool isEmergencyStopped = false;
String currentSystemStatus = "idle";

const unsigned long TELEMETRY_INTERVAL_MS = 200;
unsigned long lastTelemetryTime = 0;
float currentDistanceCm = 0.0f;

// ----------------------------------------------------------------------------
// 5. Servers (MJPEG on 81, WebSocket on 82)
// ----------------------------------------------------------------------------
httpd_handle_t stream_httpd = NULL;
WebSocketsServer wsServer(82);

#define PART_BOUNDARY "123456789000000000000987654321"
static const char* _STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char* _STREAM_BOUNDARY     = "\r\n--" PART_BOUNDARY "\r\n";
static const char* _STREAM_PART         = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

// ----------------------------------------------------------------------------
// Forward Declarations
// ----------------------------------------------------------------------------
void executeEStop(const String& reason);
void updateServos();
void readUltrasonicSensor();
void broadcastTelemetry();
void handleWebSocketEvent(uint8_t num, WStype_t type, uint8_t * payload, size_t length);
esp_err_t mjpegStreamHandler(httpd_req_t *req);
void startCameraServer();
bool initCamera();

// ============================================================================
// Setup Routine
// ============================================================================
void setup() {
  Serial.begin(115200);
  Serial.println("\n[SYSTEM] Booting ESP32-CAM 4-DOF Robotic Arm Controller...");

  // 1. Initialize Ultrasonic Sensor Pins
  pinMode(PIN_SENSOR_TRIG, OUTPUT);
  pinMode(PIN_SENSOR_ECHO, INPUT);
  digitalWrite(PIN_SENSOR_TRIG, LOW);

  // 2. Allocate & Attach Servos (50Hz standard PWM for MG90)
  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);

  servoBase.setPeriodHertz(50);
  servoShoulder.setPeriodHertz(50);
  servoElbow.setPeriodHertz(50);
  servoGripper.setPeriodHertz(50);

  servoBase.attach(PIN_SERVO_BASE, 500, 2400);
  servoShoulder.attach(PIN_SERVO_SHOULDER, 500, 2400);
  servoElbow.attach(PIN_SERVO_ELBOW, 500, 2400);
  servoGripper.attach(PIN_SERVO_GRIPPER, 500, 2400);

  servoBase.write(jointBase.currentAngle);
  servoShoulder.write(jointShoulder.currentAngle);
  servoElbow.write(jointElbow.currentAngle);
  servoGripper.write(jointGripper.currentAngle);
  Serial.println("[MOTORS] Servos initialized at home position (90 deg).");

  // 3. Connect to Wi-Fi
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("[WIFI] Connecting to %s", WIFI_SSID);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\n[WIFI] Connected successfully!");
  Serial.print("[WIFI] Assigned IP Address: ");
  Serial.println(WiFi.localIP());

  // 4. Initialize Camera & Start MJPEG Stream on Port 81
  if (initCamera()) {
    startCameraServer();
    Serial.printf("[VIDEO] MJPEG Stream live at http://%s:81/stream\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("[ERROR] Camera initialization failed! Check ribbon cable seating.");
  }

  // 5. Start WebSocket Server on Port 82
  wsServer.begin();
  wsServer.onEvent(handleWebSocketEvent);
  Serial.printf("[WS] WebSocket Telemetry/Control live at ws://%s:82/\n", WiFi.localIP().toString().c_str());

  last_ping_time = millis();
  Serial.println("[SYSTEM] Ready for operation. Watchdog active.");
}

// ============================================================================
// Main Loop
// ============================================================================
void loop() {
  unsigned long now = millis();

  wsServer.loop();

  if (!isEmergencyStopped && (now - last_ping_time > HEARTBEAT_TIMEOUT_MS)) {
    executeEStop("HEARTBEAT_TIMEOUT");
  }

  if (!isEmergencyStopped && (now - lastStepTime >= STEP_INTERVAL_MS)) {
    lastStepTime = now;
    updateServos();
  }

  if (now - lastTelemetryTime >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryTime = now;
    readUltrasonicSensor();
    broadcastTelemetry();
  }
}

// ============================================================================
// Servo Motion Smoothing Function
// ============================================================================
void updateServos() {
  bool isMoving = false;

  auto stepJoint = [&](JointState &joint, Servo &servo) {
    if (joint.currentAngle < joint.targetAngle) {
      joint.currentAngle++;
      servo.write(joint.currentAngle);
      isMoving = true;
    } else if (joint.currentAngle > joint.targetAngle) {
      joint.currentAngle--;
      servo.write(joint.currentAngle);
      isMoving = true;
    }
  };

  stepJoint(jointBase, servoBase);
  stepJoint(jointShoulder, servoShoulder);
  stepJoint(jointElbow, servoElbow);
  stepJoint(jointGripper, servoGripper);

  if (!isEmergencyStopped) {
    currentSystemStatus = isMoving ? "moving" : "idle";
  }
}

// ============================================================================
// Safety / Emergency Stop (E-Stop)
// ============================================================================
void executeEStop(const String& reason) {
  isEmergencyStopped = true;

  jointBase.targetAngle     = jointBase.currentAngle;
  jointShoulder.targetAngle = jointShoulder.currentAngle;
  jointElbow.targetAngle    = jointElbow.currentAngle;
  jointGripper.targetAngle  = jointGripper.currentAngle;

  currentSystemStatus = "stopped";
  Serial.printf("[SAFETY] E-STOP TRIGGERED! Reason: %s\n", reason.c_str());
  broadcastTelemetry();
}

// ============================================================================
// Ultrasonic Sensor Reading (Bounded Microsecond Pulse)
// ============================================================================
void readUltrasonicSensor() {
  digitalWrite(PIN_SENSOR_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_SENSOR_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_SENSOR_TRIG, LOW);

  // Reduced timeout window to 12000us (~2 meters max) to prevent main loop stutter
  long durationUs = pulseIn(PIN_SENSOR_ECHO, HIGH, 12000);

  if (durationUs > 0) {
    currentDistanceCm = (float)(durationUs * 0.0343 / 2.0);
  } else {
    currentDistanceCm = -1.0f;
  }
}

// ============================================================================
// Telemetry Broadcaster
// ============================================================================
void broadcastTelemetry() {
  StaticJsonDocument<128> doc;
  
  if (currentDistanceCm >= 0) {
    doc["distance_cm"] = serialized(String(currentDistanceCm, 1));
  } else {
    doc["distance_cm"] = nullptr;
  }
  doc["status"] = currentSystemStatus;

  String output;
  serializeJson(doc, output);
  wsServer.broadcastTXT(output);
}

// ============================================================================
// WebSocket Event Handler (Port 82)
// ============================================================================
void handleWebSocketEvent(uint8_t num, WStype_t type, uint8_t * payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED: {
      IPAddress ip = wsServer.remoteIP(num);
      Serial.printf("[WS] Client #%u connected from %d.%d.%d.%d\n", num, ip[0], ip[1], ip[2], ip[3]);
      last_ping_time = millis();
      break;
    }

    case WStype_DISCONNECTED:
      Serial.printf("[WS] Client #%u disconnected\n", num);
      break;

    case WStype_TEXT: {
      last_ping_time = millis();

      StaticJsonDocument<256> doc;
      DeserializationError error = deserializeJson(doc, payload, length);

      if (error) {
        Serial.printf("[WS] JSON Parse Failed: %s\n", error.c_str());
        return;
      }

      const char* command = doc["command"];
      if (!command) return;

      if (strcmp(command, "STOP") == 0) {
        executeEStop("CLIENT_COMMAND");
        return;
      }

      if (strcmp(command, "MOVE") == 0) {
        if (isEmergencyStopped) {
          isEmergencyStopped = false;
          Serial.println("[SAFETY] E-Stop cleared by subsequent valid MOVE command.");
        }

        if (doc.containsKey("base")) {
          int target = doc["base"];
          jointBase.targetAngle = constrain(target, MIN_ANGLE, MAX_ANGLE);
        }
        if (doc.containsKey("shoulder")) {
          int target = doc["shoulder"];
          jointShoulder.targetAngle = constrain(target, MIN_ANGLE, MAX_ANGLE);
        }
        if (doc.containsKey("elbow")) {
          int target = doc["elbow"];
          jointElbow.targetAngle = constrain(target, MIN_ANGLE, MAX_ANGLE);
        }
        if (doc.containsKey("gripper")) {
          int target = doc["gripper"];
          jointGripper.targetAngle = constrain(target, MIN_ANGLE, MAX_ANGLE);
        }
      }
      break;
    }

    default:
      break;
  }
}

// ============================================================================
// Camera & MJPEG Video Streaming (Port 81)
// ============================================================================
bool initCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0       = Y2_GPIO_NUM;
  config.pin_d1       = Y3_GPIO_NUM;
  config.pin_d2       = Y4_GPIO_NUM;
  config.pin_d3       = Y5_GPIO_NUM;
  config.pin_d4       = Y6_GPIO_NUM;
  config.pin_d5       = Y7_GPIO_NUM;
  config.pin_d6       = Y8_GPIO_NUM;
  config.pin_d7       = Y9_GPIO_NUM;
  config.pin_xclk     = XCLK_GPIO_NUM;
  config.pin_pclk     = PCLK_GPIO_NUM;
  config.pin_vsync    = VSYNC_GPIO_NUM;
  config.pin_href     = HREF_GPIO_NUM;
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn     = PWDN_GPIO_NUM;
  config.pin_reset    = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;

  if (psramFound()) {
    config.frame_size = FRAMESIZE_VGA;  // 640x480
    config.jpeg_quality = 12;
    config.fb_count = 2;
  } else {
    config.frame_size = FRAMESIZE_QVGA; // 320x240
    config.jpeg_quality = 14;
    config.fb_count = 1;
  }

  esp_err_t err = esp_camera_init(&config);
  return (err == ESP_OK);
}

esp_err_t mjpegStreamHandler(httpd_req_t *req) {
  camera_fb_t * fb = NULL;
  esp_err_t res = ESP_OK;
  size_t _jpg_buf_len = 0;
  uint8_t * _jpg_buf = NULL;
  char part_buf[64];

  res = httpd_resp_set_type(req, _STREAM_CONTENT_TYPE);
  if (res != ESP_OK) return res;

  while (true) {
    fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("[CAMERA] Frame capture failed");
      res = ESP_FAIL;
      break;
    }

    _jpg_buf_len = fb->len;
    _jpg_buf = fb->buf;

    res = httpd_resp_send_chunk(req, _STREAM_BOUNDARY, strlen(_STREAM_BOUNDARY));
    if (res != ESP_OK) {
      esp_camera_fb_return(fb);
      break;
    }

    size_t hlen = snprintf(part_buf, sizeof(part_buf), _STREAM_PART, _jpg_buf_len);
    res = httpd_resp_send_chunk(req, part_buf, hlen);
    if (res != ESP_OK) {
      esp_camera_fb_return(fn = fb); // syntax cleanup
      break;
    }

    res = httpd_resp_send_chunk(req, (const char *)_jpg_buf, _jpg_buf_len);
    esp_camera_fb_return(fb);
    if (res != ESP_OK) {
      break;
    }

    vTaskDelay(pdMS_TO_TICKS(1));
  }

  return res;
}

void startCameraServer() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 81;
  config.ctrl_port = 32768;

  httpd_uri_t stream_uri = {
    .uri      = "/stream",
    .method   = HTTP_GET,
    .handler  = mjpegStreamHandler,
    .user_ctx = NULL
  };

  if (httpd_start(&stream_httpd, &config) == ESP_OK) {
    httpd_register_uri_handler(stream_httpd, &stream_uri);
  }
}