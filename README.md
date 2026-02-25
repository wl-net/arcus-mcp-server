# Arcus MCP Server

MCP (Model Context Protocol) server that connects AI agents to the Arcus smart home platform via the client-bridge WebSocket API.

## Architecture

```
Claude Code <--stdio--> MCP Server <--WebSocket--> Client Bridge <--Kafka--> Arcus Platform
```

- **Transport**: stdio for MCP, WebSocket for Arcus bridge
- **Language**: TypeScript (ES2022, Node16 modules)
- **Dependencies**: `@modelcontextprotocol/sdk`, `ws`, `zod`

## Configuration

| Env Var | Required | Description |
|---------|----------|-------------|
| `ARCUS_BRIDGE_URL` | Yes | Bridge URL (e.g. `http://localhost:8081`) |
| `ARCUS_USERNAME` | Yes* | Login username |
| `ARCUS_PASSWORD` | Yes* | Login password |
| `ARCUS_AUTH_TOKEN` | No | Skip login, use token directly (replaces username/password) |
| `ARCUS_ENABLE_WRITE` | No | Set to `1` to enable device commands, alarm control, pairing, etc. |
| `ARCUS_DEBUG` | No | Set to `1` to log all WebSocket traffic to stderr |

*Not required if `ARCUS_AUTH_TOKEN` is set.

## Setup

```bash
npm install
npm run build
```

### Claude Code integration

```bash
claude mcp add -s user -e ARCUS_BRIDGE_URL=http://localhost:8081 \
  -e ARCUS_USERNAME=user@example.com \
  -e ARCUS_PASSWORD=password \
  -e ARCUS_ENABLE_WRITE=1 \
  arcus -- node /path/to/arcus-mcp-server/dist/index.js
```

## Source Files

| File | Description |
|------|-------------|
| `src/index.ts` | Entry point. Creates MCP server on stdio, lazy bridge connection via `ensureConnected()` |
| `src/bridge-client.ts` | WebSocket/REST client. Login, correlation-based request/response, event buffering, auto-reconnect |
| `src/tools.ts` | All 25 MCP tool definitions, response summarizers, write guard, place guard, blocklist |
| `docs/arcus-protocol.md` | Protocol reference gathered from real client traffic |

## MCP Tools (25)

### Session & Places
| Tool | Description |
|------|-------------|
| `list_places` | List all places (homes) accessible to the user |
| `set_active_place` | Activate a place — required before any device/scene/alarm operations |

### Devices
| Tool | Description |
|------|-------------|
| `list_devices` | List all devices at active place (summarized) |
| `get_device` | Get full attributes of a single device |
| `get_devices` | Batch get — fetches multiple devices in parallel |
| `device_command` | Send command to a device (switch, lock, dimmer, thermostat, shade, etc.) |
| `search_devices` | Put hub into pairing/search mode for new or reconnecting devices |

### Scenes & Rules
| Tool | Description |
|------|-------------|
| `list_scenes` | List scenes at active place |
| `fire_scene` | Execute a scene |
| `list_rules` | List automation rules |
| `delete_rule` | Delete a rule |
| `list_rule_templates` | List rule template categories, or templates in a category |
| `resolve_rule_template` | Resolve a template's variables to valid device/person options |
| `create_rule` | Create a rule from a template with variable mappings |

### Alarm
| Tool | Description |
|------|-------------|
| `arm_alarm` | Arm alarm (ON=full, PARTIAL=perimeter). Supports bypass for triggered devices |
| `disarm_alarm` | Disarm alarm |
| `list_incidents` | List alarm incidents |

### Infrastructure
| Tool | Description |
|------|-------------|
| `get_hub` | Get hub status (model, firmware, connection state, battery, Z-Wave/Zigbee info) |
| `reboot_hub` | Reboot the hub |
| `list_subsystems` | List subsystems (alarm, safety, care, etc.) |

### Events & Monitoring
| Tool | Description |
|------|-------------|
| `list_events` | Drain buffered platform events. Filters out subcare/subsafety noise, groups consecutive duplicates |
| `list_care_status` | Peek at care/safety events without draining. Shows latest unique per type |
| `list_history` | List recent history entries from the platform |
| `list_persons` | List persons at the active place |

### Advanced
| Tool | Description |
|------|-------------|
| `send_message` | Escape hatch — send any message type to any destination |

## Safety Guards

### Write Guard
All mutating operations require `ARCUS_ENABLE_WRITE=1`. Without it, device commands, alarm control, scene firing, rule creation/deletion, hub reboot, and pairing are blocked.

### Place Guard
Tools that operate on a place (`list_devices`, `get_device`, `get_devices`, `device_command`, `list_history`, `list_persons`, `delete_rule`, `fire_scene`, `get_hub`, `reboot_hub`) check that a place is set before making any bridge requests. This prevents "Tsk Tsk, you are not authorized" errors that trigger security alerts on the backend.

### Blocklist
18 destructive message types are blocked in both `device_command` and `send_message`:
- Account/place/person deletion and removal
- Hub deregistration and factory reset
- Device removal (normal and forced)
- Scene/rule deletion (via `send_message` — dedicated `delete_rule` tool exists)
- Password/PIN changes

## Key Design Decisions

- **Lazy connection**: Bridge connects on first tool call, not at startup. This avoids blocking MCP stdio transport during login/WebSocket handshake.
- **Response summarizers**: Every list tool extracts only the useful fields from raw platform responses to minimize token usage. For example, `list_devices` returns name, address, type, vendor, model, connection state, and capability-specific state (switch, lock, temperature, etc.) instead of 50+ raw attributes per device.
- **Compact JSON**: All tool responses use `JSON.stringify(x)` (no pretty-print) except where readability matters (`set_active_place`, `get_device`).
- **Event buffer**: Unsolicited WebSocket messages are buffered (max 100). `list_events` drains and groups them. `subcare:`/`subsafety:` events are filtered to a separate `list_care_status` tool since they fire constantly.
- **Auto-reconnect**: WebSocket reconnects with exponential backoff (1s, 2s, 5s, 10s, 30s). On reconnect, the active place is automatically restored.
- **Parallel requests**: `set_active_place` runs the two-phase connection flow (SetActivePlace + GetAttributes in parallel, then GetHub + ListSubsystems in parallel). `get_devices` fetches all requested devices in parallel.

## Device Command Examples

All device commands use `base:SetAttributes`:

```
# Turn on a switch
device_command(addr, "base:SetAttributes", {"swit:state": "ON"})

# Lock a door
device_command(addr, "base:SetAttributes", {"doorlock:lockstate": "LOCKED"})

# Set thermostat
device_command(addr, "base:SetAttributes", {"therm:heatsetpoint": 72})

# Dim a light to 50%
device_command(addr, "base:SetAttributes", {"dim:brightness": 50})

# Set shade position (0=closed, 100=open)
device_command(addr, "base:SetAttributes", {"shade:level": 75})
```

## Protocol Notes

See `docs/arcus-protocol.md` for the full protocol reference. Key gotchas:

- `SessionCreated` message type has no `sess:` prefix
- Place field is `placeName` (not `name`) in SessionCreated
- Outgoing messages need a top-level `type` field mirroring `payload.messageType`
- No `source` field in outgoing headers
- Hub address format: `SERV:<hubId>:hub` (e.g. `SERV:LWH-7138:hub`)
- Scenes/rules use service destinations (`SERV:scene:`, `SERV:rule:`) with `placeId` in attributes
- To arm alarm with triggered sensors, use `subalarm:ArmBypassed` instead of `subalarm:Arm`
- Pairing: `subpairing:StartPairing` then `subpairing:Search` to `SERV:subpairing:<placeId>`
