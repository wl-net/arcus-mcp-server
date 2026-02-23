# Arcus Platform Protocol Reference

Notes on the Arcus client-bridge WebSocket protocol, gathered from real client traffic.

## Authentication

1. **Login**: `POST /login` with JSON body `{"username": "...", "password": "..."}`
   - Response has `Set-Cookie: irisAuthToken=<sessionId>`
   - Can also pass token directly via `ARCUS_AUTH_TOKEN` env var

2. **WebSocket**: Connect to `ws://<host>/androidbus` with header `Cookie: irisAuthToken=<token>`

3. **SessionCreated**: First message from server after WebSocket connects:
   ```json
   {
     "payload": {
       "messageType": "SessionCreated",
       "attributes": {
         "personId": "...",
         "places": [{"placeId": "...", "placeName": "...", "accountId": "...", "role": "OWNER"}]
       }
     }
   }
   ```
   Note: `messageType` is `SessionCreated`, NOT `sess:SessionCreated`. Place field is `placeName`, not `name`.

## Message Format

### Outgoing (client → bridge)
```json
{
  "type": "sess:SetActivePlace",
  "headers": {
    "destination": "SERV:sess:",
    "correlationId": "<uuid>",
    "isRequest": true
  },
  "payload": {
    "messageType": "sess:SetActivePlace",
    "attributes": { "placeId": "..." }
  }
}
```
- Top-level `type` field mirrors `payload.messageType`
- No `source` field in outgoing headers
- Responses matched by `correlationId`

### Incoming (bridge → client)
```json
{
  "headers": {
    "isRequest": false,
    "correlationId": "<uuid>",
    "source": "SERV:sess:"
  },
  "payload": {
    "messageType": "sess:SetActivePlaceResponse",
    "attributes": { ... }
  }
}
```

## Address Formats

| Entity | Format | Example |
|--------|--------|---------|
| Session | `SERV:sess:` | `SERV:sess:` |
| Place | `SERV:place:<placeId>` | `SERV:place:1bee90ce-...` |
| Person | `SERV:person:<personId>` | `SERV:person:afabaf5c-...` |
| Device | `DRIV:dev:<deviceId>` | `DRIV:dev:fdd783a8-...` |
| Hub | `SERV:<hubId>:hub` | `SERV:LWH-7138:hub` |
| Scene | `SERV:scene:<placeId>.<n>` | `SERV:scene:1bee90ce-....1` |
| Rule | `SERV:rule:<placeId>.<n>` | `SERV:rule:1bee90ce-....1` |
| Rule Template | `SERV:ruletmpl:<templateId>` | `SERV:ruletmpl:button-chime` |
| Subsystems | `SERV:subs:` | `SERV:subs:` |
| Alarm Subsystem | `SERV:subalarm:<placeId>` | `SERV:subalarm:1bee90ce-...` |

## Connection Flow (SetActivePlace)

Two-phase flow after authentication:

**Phase 1** (parallel):
- `sess:SetActivePlace` → `SERV:sess:` with `{placeId}`
- `base:GetAttributes` → `SERV:person:<personId>`

**Phase 2** (after SetActivePlaceResponse):
- `place:GetHub` → `SERV:place:<placeId>`
- `subs:ListSubsystems` → `SERV:subs:` with `{placeId}`

## Common Message Types

### Session
| Message | Destination | Attributes |
|---------|-------------|------------|
| `sess:SetActivePlace` | `SERV:sess:` | `{placeId}` |

### Place Operations
| Message | Destination | Attributes |
|---------|-------------|------------|
| `place:GetHub` | `SERV:place:<placeId>` | `{}` |
| `place:ListDevices` | `SERV:place:<placeId>` | `{}` |
| `place:ListPersons` | `SERV:place:<placeId>` | `{}` |
| `place:ListHistoryEntries` | `SERV:place:<placeId>` | `{limit}` |

### Person
| Message | Destination | Attributes |
|---------|-------------|------------|
| `person:ListAvailablePlaces` | `SERV:person:<personId>` | `{}` |
| `base:GetAttributes` | `SERV:person:<personId>` | `{}` |

### Device Commands
| Message | Destination | Attributes |
|---------|-------------|------------|
| `base:GetAttributes` | `DRIV:dev:<id>` | `{}` |
| `base:SetAttributes` | `DRIV:dev:<id>` | `{"swit:state": "ON"\|"OFF"}` |
| `base:SetAttributes` | `DRIV:dev:<id>` | `{"dim:brightness": 0-100}` |
| `base:SetAttributes` | `DRIV:dev:<id>` | `{"doorlock:lockstate": "LOCKED"\|"UNLOCKED"}` |
| `base:SetAttributes` | `DRIV:dev:<id>` | `{"therm:heatsetpoint": temp, "therm:coolsetpoint": temp}` |
| `base:SetAttributes` | `DRIV:dev:<id>` | `{"shade:level": 0-100}` (0=closed, 100=open) |
| `shade:GoToOpen` | `DRIV:dev:<id>` | `{}` |
| `shade:GoToClose` | `DRIV:dev:<id>` | `{}` |
| `ident:Identify` | `DRIV:dev:<id>` | `{}` (flash LED on supported devices) |

### Hub
| Message | Destination | Attributes |
|---------|-------------|------------|
| `place:GetHub` | `SERV:place:<placeId>` | `{}` |
| `hubadv:Reboot` | `SERV:<hubId>:hub` | `{}` |

### Alarm
| Message | Destination | Attributes |
|---------|-------------|------------|
| `subalarm:Arm` | `SERV:subalarm:<placeId>` | `{"mode": "ON"\|"PARTIAL"}` |
| `subalarm:ArmBypassed` | `SERV:subalarm:<placeId>` | `{"mode": "ON"\|"PARTIAL"}` |
| `subalarm:Disarm` | `SERV:subalarm:<placeId>` | `{}` |
| `subalarm:ListIncidents` | `SERV:subalarm:<placeId>` | `{}` |

### Scenes
| Message | Destination | Attributes |
|---------|-------------|------------|
| `scene:ListScenes` | `SERV:scene:` | `{placeId}` |
| `scene:Fire` | `SERV:scene:<addr>` | `{}` |

### Rules
| Message | Destination | Attributes |
|---------|-------------|------------|
| `rule:ListRules` | `SERV:rule:` | `{placeId}` |
| `rule:GetCategories` | `SERV:rule:` | `{placeId}` |
| `rule:ListRuleTemplates` | `SERV:rule:` | `{placeId}` |
| `rule:Delete` | `SERV:rule:<addr>` | `{}` |
| `ruletmpl:Resolve` | `SERV:ruletmpl:<id>` | `{placeId}` |
| `ruletmpl:CreateRule` | `SERV:ruletmpl:<id>` | `{placeId, name, description, context}` |

### Subsystems
| Message | Destination | Attributes |
|---------|-------------|------------|
| `subs:ListSubsystems` | `SERV:subs:` | `{placeId}` |

## Device Capabilities

Devices have a `base:caps` array listing their capabilities. Common ones:

| Capability | Prefix | Key Attributes |
|------------|--------|----------------|
| `swit` | `swit:` | `state` (ON/OFF) |
| `dim` | `dim:` | `brightness` (0-100) |
| `temp` | `temp:` | `temperature` (celsius) |
| `humid` | `humid:` | `humidity` (%) |
| `therm` | `therm:` | `hvacmode`, `heatsetpoint`, `coolsetpoint` |
| `cont` | `cont:` | `contact` (OPENED/CLOSED) |
| `mot` | `mot:` | `motion` (DETECTED/NONE) |
| `doorlock` | `doorlock:` | `lockstate` (LOCKED/UNLOCKED/LOCKING/UNLOCKING) |
| `glass` | `glass:` | `break` (SAFE/DETECTED) |
| `pres` | `pres:` | `presence` (PRESENT/ABSENT) |
| `devpow` | `devpow:` | `source` (BATTERY/MAINS), `battery` (0-100) |
| `tamp` | `tamp:` | `tamper` (CLEAR/DETECTED) |

## Error Responses

```json
{
  "payload": {
    "messageType": "Error",
    "attributes": {
      "code": "security.triggeredDevices",
      "message": "DRIV:dev:abc,DRIV:dev:def"
    }
  }
}
```

Common error codes:
- `security.triggeredDevices` — alarm can't arm due to open sensors
- `UnsupportedMessageType` — device doesn't support the command
- `request.param.missing` — missing required parameter

## Rule Template System

Templates define automation rules with variable placeholders like `${button}`, `${switch}`, `${contact}`.

**Workflow:**
1. `rule:GetCategories` — returns category names with counts
2. `rule:ListRuleTemplates` — returns all templates (filter by `ruletmpl:categories` and `ruletmpl:satisfiable`)
3. `ruletmpl:Resolve` — returns valid options for each template variable (selectors)
4. `ruletmpl:CreateRule` — creates rule with resolved variable mappings in `context`

**Template fields:**
- `base:id` — template ID
- `ruletmpl:template` — human-readable template string with `${var}` placeholders
- `ruletmpl:categories` — array of category names
- `ruletmpl:satisfiable` — whether the template can be used with current devices
- `ruletmpl:premium` — whether it requires a premium plan

**Selector types (from Resolve):**
- `LIST` — array of `[name, address]` pairs for devices/persons
