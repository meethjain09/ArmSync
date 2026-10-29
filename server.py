"""
ESP32-CAM 4-DOF Robotic Arm - Brain & WebSocket Bridge Server
=============================================================
Framework: FastAPI + WebSockets + AsyncIO
Role:
  - Central state manager for active operating modes:
      * Tier 1A: Direct Manual Teleoperation
      * Tier 1B: Autonomous "Sense & Place" (Proximity-triggered pick-and-place)
      * Tier 1C: Computer Vision Pipeline (Stubbed for next phase)
  - Bi-directional WebSocket bridge between Web Dashboard and ESP32 (Port 82)
  - Autonomous event-driven state machine for Tier 1B
  - Static file server for HTML/JS frontend
"""

import os
import json
import asyncio
import logging
from typing import Set, Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
import websockets

# -----------------------------------------------------------------------------
# Logging & Configuration
# -----------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("RoboArmBrain")

ESP32_HOST = os.getenv("ESP32_HOST", "192.168.1.100")
ESP32_WS_PORT = int(os.getenv("ESP32_WS_PORT", "82"))
ESP32_WS_URL = f"ws://{ESP32_HOST}:{ESP32_WS_PORT}/"

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
os.makedirs(STATIC_DIR, exist_ok=True)

# -----------------------------------------------------------------------------
# System State Management
# -----------------------------------------------------------------------------
class SystemState:
    def __init__(self):
        # Modes: "1A" (Manual), "1B" (Sense & Place), "1C" (Computer Vision)
        self.active_mode: str = "1A"
        self.is_executing_sequence: bool = False
        self.latest_distance_cm: Optional[float] = None
        self.latest_esp32_status: str = "disconnected"
        self.esp32_connected: bool = False
        self.esp32_ws_client: Optional[websockets.WebSocketClientProtocol] = None
        self.frontend_clients: Set[WebSocket] = set()

state = SystemState()

# -----------------------------------------------------------------------------
# Kinematic Sequence Definitions for Tier 1B (Sense & Place)
# -----------------------------------------------------------------------------
TIER_1B_PICK_AND_PLACE_STEPS = [
    # Step 1: Pre-grasp approach with open gripper
    {"name": "Pre-Grasp Approach", "payload": {"command": "MOVE", "base": 90, "shoulder": 115, "elbow": 105, "gripper": 30}, "delay": 1.2},
    # Step 2: Grasp target object firmly
    {"name": "Grip Target", "payload": {"command": "MOVE", "base": 90, "shoulder": 115, "elbow": 105, "gripper": 135}, "delay": 0.8},
    # Step 3: Vertical lift clearance
    {"name": "Lift Object", "payload": {"command": "MOVE", "base": 90, "shoulder": 75, "elbow": 75, "gripper": 135}, "delay": 1.0},
    # Step 4: Azimuth rotation to drop zone (160 degrees)
    {"name": "Rotate to Drop Zone", "payload": {"command": "MOVE", "base": 160, "shoulder": 75, "elbow": 75, "gripper": 135}, "delay": 1.4},
    # Step 5: Lower arm towards deposit receptacle
    {"name": "Descend to Drop Tray", "payload": {"command": "MOVE", "base": 160, "shoulder": 110, "elbow": 100, "gripper": 135}, "delay": 1.0},
    # Step 6: Release gripper jaws
    {"name": "Release Object", "payload": {"command": "MOVE", "base": 160, "shoulder": 110, "elbow": 100, "gripper": 30}, "delay": 0.8},
    # Step 7: Reset to neutral observation pose
    {"name": "Return to Home", "payload": {"command": "MOVE", "base": 90, "shoulder": 90, "elbow": 90, "gripper": 90}, "delay": 1.2},
]

# -----------------------------------------------------------------------------
# Background Bridge & Task Managers
# -----------------------------------------------------------------------------
async def send_to_esp32(payload: dict) -> bool:
    """Dispatches a JSON command to the physical ESP32."""
    if state.esp32_ws_client and state.esp32_connected:
        try:
            await state.esp32_ws_client.send(json.dumps(payload))
            return True
        except Exception as err:
            logger.error(f"Failed to transmit to ESP32: {err}")
            state.esp32_connected = False
    return False

async def broadcast_to_frontends(message: dict):
    """Broadcasts telemetry or system state changes to all web dashboards."""
    disconnected = set()
    payload_str = json.dumps(message)
    for client in list(state.frontend_clients):
        try:
            await client.send_text(payload_str)
        except Exception:
            disconnected.add(client)
    state.frontend_clients.difference_update(disconnected)

# -----------------------------------------------------------------------------
# Tier 1B Autonomous Routine
# -----------------------------------------------------------------------------
async def trigger_tier_1b_sense_and_place():
    """
    Executes the autonomous Sense & Place sequence with non-blocking delays
    between kinematic transitions to guarantee physical servo settling.
    """
    if state.is_executing_sequence:
        return

    state.is_executing_sequence = True
    logger.info(">>> [TIER 1B] Object detected within 10cm! Commencing Sense & Place sequence.")

    await broadcast_to_frontends({
        "event": "SEQUENCE_STARTED",
        "mode": "1B",
        "description": "Sense & Place routine initiated."
    })

    try:
        for idx, step in enumerate(TIER_1B_PICK_AND_PLACE_STEPS, start=1):
            # Check if mode switched or E-Stop was commanded mid-sequence
            if state.active_mode != "1B":
                logger.warning("[TIER 1B] Sequence aborted: Mode changed during execution.")
                break

            logger.info(f"[TIER 1B] Step {idx}/{len(TIER_1B_PICK_AND_PLACE_STEPS)}: {step['name']}")
            await send_to_esp32(step["payload"])

            await broadcast_to_frontends({
                "event": "SEQUENCE_STEP",
                "step_index": idx,
                "step_name": step["name"],
                "target": step["payload"]
            })

            await asyncio.sleep(step["delay"])

    except Exception as e:
        logger.error(f"[TIER 1B] Error executing sequence: {e}")
    finally:
        state.is_executing_sequence = False
        logger.info("<<< [TIER 1B] Sense & Place sequence finished. Returning to monitoring.")
        await broadcast_to_frontends({
            "event": "SEQUENCE_COMPLETED",
            "mode": "1B"
        })

# -----------------------------------------------------------------------------
# Tier 1C Computer Vision Pipeline (Placeholder)
# -----------------------------------------------------------------------------
async def process_cv_tier_1c():
    """
    Placeholder for Tier 1C Computer Vision Pipeline.
    Will consume the MJPEG stream from port 81, run object detection/color tracking,
    and output Cartesian/joint coordinates.
    """
    logger.debug("[TIER 1C] CV Pipeline tick (placeholder - ready for integration)")

# -----------------------------------------------------------------------------
# ESP32 WebSocket Bridge Loop
# -----------------------------------------------------------------------------
async def esp32_bridge_worker():
    """
    Persistent background worker that maintains the WebSocket connection to the ESP32.
    Handles telemetry streaming, watchdog heartbeats, and triggers Tier 1B automation.
    """
    while True:
        try:
            logger.info(f"[BRIDGE] Connecting to ESP32 WebSocket at {ESP32_WS_URL}...")
            async with websockets.connect(ESP32_WS_URL, ping_interval=None) as ws:
                state.esp32_ws_client = ws
                state.esp32_connected = True
                logger.info("[BRIDGE] Successfully connected to ESP32-CAM!")

                # Send an initial ping/keepalive immediately
                await ws.send(json.dumps({"command": "PING"}))

                while True:
                    try:
                        raw_msg = await asyncio.wait_for(ws.recv(), timeout=1.0)
                        data = json.loads(raw_msg)

                        # Update cached telemetry
                        if "distance_cm" in data:
                            state.latest_distance_cm = data["distance_cm"]
                        if "status" in data:
                            state.latest_esp32_status = data["status"]

                        # Append server brain metadata to broadcast
                        enriched_payload = {
                            "type": "TELEMETRY",
                            "esp32": data,
                            "active_mode": state.active_mode,
                            "is_executing_sequence": state.is_executing_sequence
                        }
                        await broadcast_to_frontends(enriched_payload)

                        # Check Tier 1B trigger condition: distance < 10cm
                        if (state.active_mode == "1B" and 
                            state.latest_distance_cm is not None and 
                            0 < state.latest_distance_cm < 10.0 and 
                            not state.is_executing_sequence):
                            
                            # Fire autonomous sequence in background
                            asyncio.create_task(trigger_tier_1b_sense_and_place())

                        # Tier 1C hook
                        elif state.active_mode == "1C":
                            asyncio.create_task(process_cv_tier_1c())

                    except asyncio.TimeoutError:
                        # Periodic 1-second heartbeat to keep the ESP32 2000ms watchdog alive
                        if state.esp32_connected:
                            await ws.send(json.dumps({"command": "PING"}))

        except (websockets.exceptions.ConnectionClosed, OSError) as e:
            state.esp32_connected = False
            state.latest_esp32_status = "disconnected"
            logger.warning(f"[BRIDGE] ESP32 connection lost ({e}). Retrying in 2.0s...")
            await broadcast_to_frontends({
                "type": "ESP32_CONNECTION_STATUS",
                "connected": False,
                "error": str(e)
            })
            await asyncio.sleep(2.0)
        except Exception as e:
            logger.error(f"[BRIDGE] Unexpected error: {e}")
            await asyncio.sleep(2.0)

# -----------------------------------------------------------------------------
# FastAPI Application & Lifespan
# -----------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Spawn background bridge worker
    task = asyncio.create_task(esp32_bridge_worker())
    logger.info("[LIFESPAN] Server started. Background ESP32 bridge active.")
    yield
    task.cancel()
    if state.esp32_ws_client:
        await state.esp32_ws_client.close()
    logger.info("[LIFESPAN] Server shutdown complete.")

app = FastAPI(title="RoboArm FastAPI Brain", lifespan=lifespan)

# -----------------------------------------------------------------------------
# REST Endpoints for Mode Configuration
# -----------------------------------------------------------------------------
class ModeRequest(BaseModel):
    mode: str

@app.get("/api/state")
async def get_system_state():
    return {
        "active_mode": state.active_mode,
        "esp32_connected": state.esp32_connected,
        "esp32_status": state.latest_esp32_status,
        "distance_cm": state.latest_distance_cm,
        "is_executing_sequence": state.is_executing_sequence
    }

@app.post("/api/mode")
async def set_system_mode(req: ModeRequest):
    allowed_modes = {"1A", "1B", "1C"}
    if req.mode not in allowed_modes:
        raise HTTPException(status_code=400, detail=f"Invalid mode. Must be one of {allowed_modes}")

    previous_mode = state.active_mode
    state.active_mode = req.mode
    logger.info(f"[MODE] Mode switched from {previous_mode} -> {state.active_mode}")

    await broadcast_to_frontends({
        "type": "MODE_CHANGE",
        "previous_mode": previous_mode,
        "active_mode": state.active_mode
    })
    return {"status": "success", "active_mode": state.active_mode}

@app.post("/api/estop")
async def emergency_stop():
    """High-priority REST emergency stop endpoint."""
    logger.warning("[SAFETY] E-Stop issued via REST endpoint!")
    state.is_executing_sequence = False
    await send_to_esp32({"command": "STOP"})
    await broadcast_to_frontends({"type": "ESTOP_TRIGGERED"})
    return {"status": "stopped"}

# -----------------------------------------------------------------------------
# Frontend WebSocket Endpoint (/ws)
# -----------------------------------------------------------------------------
@app.websocket("/ws")
async def frontend_websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    state.frontend_clients.add(websocket)
    logger.info(f"[FRONTEND WS] Dashboard connected. Total clients: {len(state.frontend_clients)}")

    # Send initial snapshot
    await websocket.send_text(json.dumps({
        "type": "INITIAL_STATE",
        "active_mode": state.active_mode,
        "esp32_connected": state.esp32_connected,
        "esp32_status": state.latest_esp32_status,
        "distance_cm": state.latest_distance_cm,
        "is_executing_sequence": state.is_executing_sequence
    }))

    try:
        while True:
            text_data = await websocket.receive_text()
            try:
                cmd = json.loads(text_data)
            except json.JSONDecodeError:
                continue

            # Command: Change Mode
            if cmd.get("command") == "SET_MODE" and "mode" in cmd:
                mode_val = cmd["mode"]
                if mode_val in ["1A", "1B", "1C"]:
                    state.active_mode = mode_val
                    logger.info(f"[FRONTEND WS] Mode switched to {state.active_mode}")
                    await broadcast_to_frontends({
                        "type": "MODE_CHANGE",
                        "active_mode": state.active_mode
                    })
                continue

            # Command: Emergency Stop
            if cmd.get("command") == "STOP":
                logger.warning("[SAFETY] E-Stop triggered from frontend WebSocket!")
                state.is_executing_sequence = False
                await send_to_esp32({"command": "STOP"})
                await broadcast_to_frontends({"type": "ESTOP_TRIGGERED"})
                continue

            # Command: Manual Move (Tier 1A only)
            if cmd.get("command") == "MOVE":
                if state.active_mode == "1A":
                    # Forward directly to ESP32
                    await send_to_esp32(cmd)
                else:
                    await websocket.send_text(json.dumps({
                        "type": "WARNING",
                        "message": f"Manual move ignored. System is currently in Mode {state.active_mode}."
                    }))

    except WebSocketDisconnect:
        state.frontend_clients.remove(websocket)
        logger.info(f"[FRONTEND WS] Dashboard disconnected. Remaining: {len(state.frontend_clients)}")

# -----------------------------------------------------------------------------
# Static Files & Dashboard UI Route
# -----------------------------------------------------------------------------
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/")
async def serve_index():
    index_file = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file)
    return JSONResponse({
        "message": "FastAPI RoboArm Brain is running.",
        "active_mode": state.active_mode,
        "esp32_target": ESP32_WS_URL,
        "instructions": "Place your dashboard index.html in the /static directory."
    })

# -----------------------------------------------------------------------------
# Local Dev Entry Point
# -----------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
