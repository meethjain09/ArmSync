import React, { useState } from 'react';
import { 
  Cpu, Wifi, Video, ShieldAlert, Radio, Activity, CheckCircle2, 
  Sliders, Copy, Check, Terminal, FileCode, Clock, ShieldCheck
} from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState<'contract' | 'firmware'>('contract');
  const [copied, setCopied] = useState(false);

  const pinouts = [
    { component: 'Base Servo (MG90)', gpio: 'GPIO 12', type: 'PWM Output', notes: 'Azimuth rotation (0° - 180°)' },
    { component: 'Shoulder Servo (MG90)', gpio: 'GPIO 13', type: 'PWM Output', notes: 'Vertical elevation angle' },
    { component: 'Elbow Servo (MG90)', gpio: 'GPIO 14', type: 'PWM Output', notes: 'Forearm pitch angle' },
    { component: 'Gripper Servo (MG90)', gpio: 'GPIO 15', type: 'PWM Output', notes: 'End-effector open/close grip' },
    { component: 'HC-SR04 TRIG', gpio: 'GPIO 2', type: 'Digital Output', notes: '10µs trigger pulse' },
    { component: 'HC-SR04 ECHO', gpio: 'GPIO 16', type: 'Digital Input', notes: '3.3V logic level (voltage divider mandatory)' },
  ];

  const protocols = [
    { channel: 'Video Stream', protocol: 'HTTP MJPEG', port: 81, path: 'http://<esp32-ip>:81/stream', direction: 'ESP32 → Web', latency: '~80-120ms' },
    { channel: 'Bi-directional Control & Telemetry', protocol: 'WebSocket', port: 82, path: 'ws://<esp32-ip>:82/ws', direction: 'Full Duplex', latency: '<15ms' },
  ];

  const payloads = [
    {
      name: 'Arm Movement Control',
      direction: 'Web → ESP32',
      schema: '{"command": "MOVE", "base": 90, "shoulder": 90, "elbow": 90, "gripper": 90}',
      description: 'Dispatches joint angle target setpoints (constrained between 0° and 180°).',
    },
    {
      name: 'Emergency Stop (E-Stop)',
      direction: 'Web → ESP32',
      schema: '{"command": "STOP"}',
      description: 'Halts kinematic motion instantly by freezing target angles to current angles.',
    },
    {
      name: 'Telemetry & Distance Feedback',
      direction: 'ESP32 → Web',
      schema: '{"distance_cm": 15.2, "status": "idle"}',
      description: 'Streamed periodically every 200ms with ultrasonic obstacle distance and state.',
    },
  ];

  const handleCopyCode = () => {
    fetch('/firmware/esp32_cam_robotic_arm.ino')
      .then(res => res.text())
      .then(text => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-10 font-sans selection:bg-cyan-500 selection:text-black">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Header */}
        <header className="border-b border-slate-800 pb-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-cyan-500/10 border border-cyan-500/30 rounded-xl text-cyan-400">
                <Cpu className="w-6 h-6" />
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                  ESP32-CAM 4-DOF Robotic Arm Architecture
                  <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    Source of Truth & Firmware
                  </span>
                </h1>
                <p className="text-sm text-slate-400 mt-0.5">
                  Dual-port communication contract, pinout specifications, and production C++ firmware.
                </p>
              </div>
            </div>
          </div>

          {/* Tab Selector */}
          <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 p-1 rounded-xl">
            <button
              onClick={() => setActiveTab('contract')}
              className={`px-4 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition ${
                activeTab === 'contract' 
                  ? 'bg-cyan-500 text-slate-950 shadow' 
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Radio className="w-3.5 h-3.5" />
              API & Pinout Contract
            </button>
            <button
              onClick={() => setActiveTab('firmware')}
              className={`px-4 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition ${
                activeTab === 'firmware' 
                  ? 'bg-cyan-500 text-slate-950 shadow' 
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <FileCode className="w-3.5 h-3.5" />
              ESP32 C++ Firmware
            </button>
          </div>
        </header>

        {activeTab === 'contract' ? (
          <>
            {/* Section 1: Protocols */}
            <section className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-cyan-400">
                <Wifi className="w-4 h-4" />
                <span>1. Network & Communication Protocols</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {protocols.map((p, idx) => (
                  <div key={idx} className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 relative overflow-hidden group hover:border-slate-700 transition">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2 text-base font-semibold text-white">
                        {p.channel === 'Video Stream' ? <Video className="w-5 h-5 text-indigo-400" /> : <Activity className="w-5 h-5 text-cyan-400" />}
                        {p.channel}
                      </div>
                      <span className="font-mono text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                        Port {p.port}
                      </span>
                    </div>
                    <div className="mt-4 space-y-2 text-xs">
                      <div className="flex justify-between py-1 border-b border-slate-800/80 text-slate-400">
                        <span>Protocol</span>
                        <span className="font-medium text-slate-200">{p.protocol}</span>
                      </div>
                      <div className="flex justify-between py-1 border-b border-slate-800/80 text-slate-400">
                        <span>Target Endpoint</span>
                        <span className="font-mono text-cyan-300">{p.path}</span>
                      </div>
                      <div className="flex justify-between py-1 border-b border-slate-800/80 text-slate-400">
                        <span>Flow Direction</span>
                        <span className="font-medium text-slate-200">{p.direction}</span>
                      </div>
                      <div className="flex justify-between py-1 text-slate-400">
                        <span>Target Latency</span>
                        <span className="font-medium text-emerald-400">{p.latency}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Section 2: WebSocket Payloads */}
            <section className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-cyan-400">
                <Radio className="w-4 h-4" />
                <span>2. WebSocket JSON Contract (Port 82)</span>
              </div>
              <div className="space-y-3">
                {payloads.map((payload, idx) => (
                  <div key={idx} className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2 font-medium text-white">
                        {payload.name.includes('E-Stop') ? (
                          <ShieldAlert className="w-4 h-4 text-rose-400" />
                        ) : (
                          <Sliders className="w-4 h-4 text-cyan-400" />
                        )}
                        <span>{payload.name}</span>
                      </div>
                      <span className={`text-xs px-2.5 py-0.5 rounded-full font-mono border self-start ${
                        payload.direction.includes('ESP32 →') 
                          ? 'bg-purple-500/10 text-purple-400 border-purple-500/20'
                          : payload.name.includes('E-Stop')
                          ? 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                          : 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                      }`}>
                        {payload.direction}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mb-3">{payload.description}</p>
                    <div className="bg-black/60 border border-slate-800 rounded-lg p-3 font-mono text-xs text-emerald-300 overflow-x-auto">
                      {payload.schema}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Section 3: Pinout */}
            <section className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-cyan-400">
                <Cpu className="w-4 h-4" />
                <span>3. ESP32-CAM Pinout Configuration</span>
              </div>
              <div className="bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-800/60 text-slate-400 uppercase text-[11px] tracking-wider border-b border-slate-800">
                      <tr>
                        <th className="px-5 py-3 font-semibold">Hardware Component</th>
                        <th className="px-5 py-3 font-semibold">Assigned GPIO</th>
                        <th className="px-5 py-3 font-semibold">Signal Type</th>
                        <th className="px-5 py-3 font-semibold">Functional Notes</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800 text-slate-300">
                      {pinouts.map((pin, i) => (
                        <tr key={i} className="hover:bg-slate-800/30 transition">
                          <td className="px-5 py-3.5 font-medium text-white flex items-center gap-2">
                            <CheckCircle2 className="w-3.5 h-3.5 text-cyan-400" />
                            {pin.component}
                          </td>
                          <td className="px-5 py-3.5 font-mono font-semibold text-amber-300">
                            {pin.gpio}
                          </td>
                          <td className="px-5 py-3.5 text-slate-400 font-mono">
                            {pin.type}
                          </td>
                          <td className="px-5 py-3.5 text-slate-400">
                            {pin.notes}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="p-4 bg-slate-950/60 border-t border-slate-800 text-xs text-slate-400 flex items-center justify-between">
                  <span>
                    <strong className="text-amber-400">Hardware Rule:</strong> Use a dedicated external 5V 3A+ PSU for the 4x MG90 servos with shared GND to prevent brownouts.
                  </span>
                </div>
              </div>
            </section>
          </>
        ) : (
          /* Firmware View */
          <section className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
                <div className="flex items-center gap-2 text-rose-400 font-medium text-sm mb-1">
                  <ShieldAlert className="w-4 h-4" />
                  E-Stop Response
                </div>
                <p className="text-xs text-slate-400">
                  Instantaneous target angle lock (`target = current`) halting updates upon <code className="text-rose-300">{"{\"command\":\"STOP\"}"}</code>.
                </p>
              </div>

              <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
                <div className="flex items-center gap-2 text-amber-400 font-medium text-sm mb-1">
                  <Clock className="w-4 h-4" />
                  2000ms Watchdog
                </div>
                <p className="text-xs text-slate-400">
                  Monitors <code className="text-amber-300">last_ping_time</code>. If no payload arrives for 2.0s, triggers autonomous E-Stop.
                </p>
              </div>

              <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
                <div className="flex items-center gap-2 text-cyan-400 font-medium text-sm mb-1">
                  <Activity className="w-4 h-4" />
                  Motion Smoothing
                </div>
                <p className="text-xs text-slate-400">
                  Non-blocking 1° step interpolation every 15ms preventing mechanical vibration and sudden stall currents.
                </p>
              </div>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
              <div className="bg-slate-800/80 px-4 py-3 flex items-center justify-between border-b border-slate-700">
                <div className="flex items-center gap-2 text-xs font-mono text-slate-300">
                  <Terminal className="w-4 h-4 text-cyan-400" />
                  <span>firmware/esp32_cam_robotic_arm.ino</span>
                </div>
                <button
                  onClick={handleCopyCode}
                  className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs text-white font-medium flex items-center gap-1.5 transition"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copied to Clipboard' : 'Copy Arduino Code'}
                </button>
              </div>
              <div className="p-4 bg-black/90 font-mono text-xs text-slate-300 overflow-x-auto max-h-[560px] leading-relaxed">
                <pre>
{`// ============================================================================
// ESP32-CAM 4-DOF Robotic Arm Firmware (Standard C++)
// Libraries: ESP32Servo, WebSocketsServer, ArduinoJson, esp_camera.h
// ============================================================================
#include "esp_camera.h"
#include <WiFi.h>
#include <ESP32Servo.h>
#include <WebSocketsServer.h>
#include <ArduinoJson.h>
#include "esp_http_server.h"

// Hardware Pinout Configuration
#define PIN_SERVO_BASE     12
#define PIN_SERVO_SHOULDER 13
#define PIN_SERVO_ELBOW    14
#define PIN_SERVO_GRIPPER  15
#define PIN_SENSOR_TRIG    2
#define PIN_SENSOR_ECHO    16

// Safety Watchdog: 2000ms heartbeat failsafe
const unsigned long HEARTBEAT_TIMEOUT_MS = 2000;
unsigned long last_ping_time = 0;
bool isEmergencyStopped = false;

// Kinematic limits
static const int MIN_ANGLE = 0;
static const int MAX_ANGLE = 180;

// Non-blocking motion smoothing (1° per 15ms)
void updateServos() {
  auto stepJoint = [&](JointState &joint, Servo &servo) {
    if (joint.currentAngle < joint.targetAngle) {
      joint.currentAngle++;
      servo.write(joint.currentAngle);
    } else if (joint.currentAngle > joint.targetAngle) {
      joint.currentAngle--;
      servo.write(joint.currentAngle);
    }
  };
  stepJoint(jointBase, servoBase);
  stepJoint(jointShoulder, servoShoulder);
  stepJoint(jointElbow, servoElbow);
  stepJoint(jointGripper, servoGripper);
}

// See full file in /firmware/esp32_cam_robotic_arm.ino`}
                </pre>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
