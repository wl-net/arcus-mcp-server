# Arcus Platform Commands

Complete list of message types extracted from the Arcus platform capability definitions.
Commands marked with **[MCP]** have a dedicated MCP tool implemented in this server. Commands marked with **[BLOCKED]** are blocked by the safety blocklist. All others can be sent via the `send_message` escape hatch.

## Session

| Command | Description |
|---------|-------------|
| `sess:SetActivePlace` | **[MCP]** Set the active place for the session |

## Place

| Command | Description |
|---------|-------------|
| `place:ListDevices` | **[MCP]** List all devices at the place |
| `place:ListPersons` | **[MCP]** List all persons at the place |
| `place:ListHistoryEntries` | **[MCP]** List recent history entries |
| `place:GetHub` | **[MCP]** Get hub info for the place |
| `place:ListDashboardEntries` | List dashboard entries |
| `place:ListPersonsWithAccess` | List persons with access to the place |
| `place:PendingInvitations` | List pending invitations |
| `place:CreateInvitation` | Create an invitation |
| `place:SendInvitation` | Send an invitation |
| `place:CancelInvitation` | Cancel a pending invitation |
| `place:AddPerson` | Add a person to the place |
| `place:UpdateAddress` | Update the place address |
| `place:RegisterHub` | Register a hub to the place |
| `place:RegisterHubV2` | Register a hub (v2) |
| `place:StartAddingDevices` | Start adding devices |
| `place:StopAddingDevices` | Stop adding devices |
| `place:Delete` | **[BLOCKED]** Delete the place |

## Person

| Command | Description |
|---------|-------------|
| `person:ListAvailablePlaces` | **[MCP]** List places the person can access |
| `person:ListHistoryEntries` | List history entries for a person |
| `person:ListMobileDevices` | List mobile devices for a person |
| `person:AddMobileDevice` | Register a mobile device |
| `person:RemoveMobileDevice` | Remove a mobile device |
| `person:PendingInvitations` | List pending invitations for a person |
| `person:AcceptInvitation` | Accept a place invitation |
| `person:RejectInvitation` | Reject a place invitation |
| `person:AcceptPolicy` | Accept a policy |
| `person:RejectPolicy` | Reject a policy |
| `person:SendVerificationEmail` | Send email verification |
| `person:VerifyEmail` | Verify email address |
| `person:VerifyPin` | Verify a PIN |
| `person:GetSecurityAnswers` | Get security answers |
| `person:SetSecurityAnswers` | Set security answers |
| `person:PromoteToAccount` | Promote person to account owner |
| `person:DeleteLogin` | Delete login credentials |
| `person:ChangePin` | **[BLOCKED]** Change PIN |
| `person:ChangePinV2` | Change PIN (v2) |
| `person:SetPassword` | **[BLOCKED]** Set password |
| `person:ChangePassword` | **[BLOCKED]** Change password |
| `person:Delete` | **[BLOCKED]** Delete person |
| `person:RemoveFromPlace` | **[BLOCKED]** Remove person from place |

## Account

| Command | Description |
|---------|-------------|
| `account:ListPlaces` | List places on the account |
| `account:ListDevices` | List devices on the account |
| `account:ListHubs` | List hubs on the account |
| `account:ListInvoices` | List invoices |
| `account:ListAdjustments` | List billing adjustments |
| `account:Activate` | Activate account |
| `account:AddPlace` | Add a place to the account |
| `account:CreateBillingAccount` | Create billing account |
| `account:UpdateBillingInfoCC` | Update credit card info |
| `account:UpdateServicePlan` | Update service plan |
| `account:SkipPremiumTrial` | Skip premium trial |
| `account:RedeemCoupon` | Redeem a coupon |
| `account:SignupTransition` | Transition signup state |
| `account:IssueCredit` | Issue account credit |
| `account:IssueInvoiceRefund` | Issue invoice refund |
| `account:Delete` | **[BLOCKED]** Delete account |
| `accountmig:MigrateBillingAccount` | Migrate billing account |

## Device (General)

| Command | Description |
|---------|-------------|
| `base:GetAttributes` | **[MCP]** Get all device attributes |
| `base:SetAttributes` | **[MCP]** Set device attributes |
| `dev:ListHistoryEntries` | List history entries for a device |
| `dev:Remove` | **[BLOCKED]** Remove a device |
| `dev:ForceRemove` | **[BLOCKED]** Force remove a device |
| `devadv:GetReflexes` | Get device reflexes |
| `devadv:Reconfigure` | Reconfigure device driver |
| `devadv:UpgradeDriver` | Upgrade device driver |
| `devota:FirmwareUpdate` | Start firmware update |
| `devota:FirmwareUpdateCancel` | Cancel firmware update |
| `ident:Identify` | **[MCP]** Flash LED on supported devices |

## Switch / Dimmer / Light

| Command | Description |
|---------|-------------|
| `base:SetAttributes` | Set `swit:state` (ON/OFF), `dim:brightness` (0-100) |
| `dim:IncrementBrightness` | Increment brightness |
| `dim:DecrementBrightness` | Decrement brightness |
| `dim:RampBrightness` | Ramp brightness over time |

## Color / Color Temperature

| Command | Description |
|---------|-------------|
| `base:SetAttributes` | Set `color:hue`, `color:saturation`, `colortemp:colortemp` |

## Thermostat

| Command | Description |
|---------|-------------|
| `base:SetAttributes` | Set `therm:hvacmode`, `therm:heatsetpoint`, `therm:coolsetpoint` |
| `therm:SetIdealTemperature` | Set ideal temperature |
| `therm:IncrementIdealTemperature` | Increment ideal temp |
| `therm:DecrementIdealTemperature` | Decrement ideal temp |
| `therm:changeFilter` | Mark filter as changed |

## Door Lock

| Command | Description |
|---------|-------------|
| `base:SetAttributes` | Set `doorlock:lockstate` (LOCKED/UNLOCKED) |
| `doorlock:AuthorizePerson` | **[MCP]** Authorize a person's PIN |
| `doorlock:DeauthorizePerson` | **[MCP]** Deauthorize a person's PIN |
| `doorlock:BuzzIn` | **[MCP]** Buzz someone in |
| `doorlock:ClearAllPins` | Clear all PINs from lock |

## Shade / Blind

| Command | Description |
|---------|-------------|
| `base:SetAttributes` | Set `shade:level` (0=closed, 100=open) |
| `shade:GoToOpen` | Open shade fully |
| `shade:GoToClosed` | Close shade fully |
| `shade:GoToFavorite` | Go to favorite position |
| `somfyv1:GoToOpen` | Somfy open |
| `somfyv1:GoToClosed` | Somfy close |
| `somfyv1:GoToFavorite` | Somfy favorite position |

## Garage Door / Motorized Door

| Command | Description |
|---------|-------------|
| `base:SetAttributes` | Set `motdoor:doorstate` (OPEN/CLOSED) |

## Valve

| Command | Description |
|---------|-------------|
| `base:SetAttributes` | Set `valv:valvestate` (OPEN/CLOSED) |

## Fan / Vent

| Command | Description |
|---------|-------------|
| `base:SetAttributes` | Set `fan:speed`, `vent:level` |

## Space Heater

| Command | Description |
|---------|-------------|
| `base:SetAttributes` | Set `spaceheater:setpoint`, `spaceheater:heatstate` |

## Halo (Smoke/CO Detector)

| Command | Description |
|---------|-------------|
| `halo:StartTest` | Start self-test |
| `halo:StartHush` | Start hush mode |
| `halo:SendHush` | Send hush command |
| `halo:CancelHush` | Cancel hush mode |

## Pet Door

| Command | Description |
|---------|-------------|
| `base:SetAttributes` | Set `petdoor:lockstate` |
| `petdoor:RemoveToken` | Remove a pet token |

## Irrigation Controller

| Command | Description |
|---------|-------------|
| `irrcont:WaterNow` | Start watering a zone |
| `irrcont:WaterNowV2` | Start watering (v2) |
| `irrcont:Cancel` | Cancel watering |
| `irrcont:CancelV2` | Cancel watering (v2) |

## Irrigation Schedule

| Command | Description |
|---------|-------------|
| `irrsched:SetWeeklySchedule` | Set weekly watering schedule |
| `irrsched:SetIntervalSchedule` | Set interval watering schedule |
| `irrsched:SetEvenOddSchedule` | Set even/odd day schedule |
| `irrsched:SetIntervalStart` | Set interval start time |
| `irrsched:ClearWeeklySchedule` | Clear weekly schedule |
| `irrsched:ClearIntervalSchedule` | Clear interval schedule |
| `irrsched:ClearEvenOddSchedule` | Clear even/odd schedule |
| `irrsched:EnableSchedule` | Enable irrigation schedule |
| `irrsched:DisableSchedule` | Disable irrigation schedule |

## Camera

| Command | Description |
|---------|-------------|
| `camera:StartStreaming` | Start camera stream |
| `cameraptz:GotoHome` | Move camera to home position |
| `cameraptz:GotoAbsolute` | Move camera to absolute position |
| `cameraptz:GotoRelative` | Move camera relative to current |

## Recording / Video

| Command | Description |
|---------|-------------|
| `video:View` | View a recording |
| `video:Download` | Download a recording |
| `video:Resurrect` | Resurrect a deleted recording |
| `video:Delete` | Delete a recording |

## Media Player

| Command | Description |
|---------|-------------|
| `mediaplayer:Play` | Play |
| `mediaplayer:Pause` | Pause |
| `mediaplayer:Stop` | Stop |
| `mediaplayer:Mute` | Mute |
| `mediaplayer:Unmute` | Unmute |

## Weather Radio (NOAA)

| Command | Description |
|---------|-------------|
| `noaa:ScanStations` | Scan for NOAA stations |
| `noaa:SelectStation` | Select a station |
| `noaa:PlayStation` | Play selected station |
| `noaa:StopPlayingStation` | Stop playing |

## Water Softener

| Command | Description |
|---------|-------------|
| `watersoftener:rechargeNow` | Start recharge cycle |

## WiFi (Device)

| Command | Description |
|---------|-------------|
| `wifi:Connect` | Connect to WiFi network |
| `wifi:Disconnect` | Disconnect from WiFi |
| `wifiscan:StartWifiScan` | Start WiFi scan |
| `wifiscan:EndWifiScan` | End WiFi scan |

## KeyPad

| Command | Description |
|---------|-------------|
| `keypad:BeginArming` | Begin arming sequence |
| `keypad:Armed` | Set armed state |
| `keypad:Disarmed` | Set disarmed state |
| `keypad:Alerting` | Set alerting state |
| `keypad:Soaking` | Set soaking (entry delay) state |
| `keypad:ArmingUnavailable` | Set arming unavailable |
| `keypad:Chime` | Play chime sound |

---

## Scenes

| Command | Description |
|---------|-------------|
| `scene:Fire` | **[MCP]** Fire a scene |
| `scene:Delete` | **[BLOCKED]** Delete a scene |
| `scenetmpl:Create` | Create a scene from template |
| `scenetmpl:ResolveActions` | Resolve available actions for a template |

## Rules

| Command | Description |
|---------|-------------|
| `rule:ListRules` | **[MCP]** List all rules |
| `rule:Delete` | **[MCP]** Delete a rule (dedicated tool) |
| `rule:Enable` | **[MCP]** Enable a rule |
| `rule:Disable` | **[MCP]** Disable a rule |
| `rule:UpdateContext` | Update rule variable context |
| `rule:ListHistoryEntries` | List rule history |
| `rule:GetCategories` | **[MCP]** Get rule categories |
| `rule:ListRuleTemplates` | **[MCP]** List rule templates |
| `ruletmpl:Resolve` | **[MCP]** Resolve template variables |
| `ruletmpl:CreateRule` | **[MCP]** Create rule from template |

## Scheduler

| Command | Description |
|---------|-------------|
| `scheduler:AddWeeklySchedule` | Add a weekly schedule |
| `scheduler:FireCommand` | Fire a scheduled command |
| `scheduler:RecalculateSchedule` | Recalculate schedule |
| `scheduler:Delete` | Delete a scheduler |
| `schedulable:EnableSchedule` | Enable a device schedule |
| `schedulable:DisableSchedule` | Disable a device schedule |
| `schedweek:ScheduleWeeklyCommand` | Add weekly command |
| `schedweek:UpdateWeeklyCommand` | Update weekly command |
| `sched:Delete` | Delete a schedule |
| `sched:DeleteCommand` | Delete a schedule command |

## Product Catalog

| Command | Description |
|---------|-------------|
| `prodcat:GetProducts` | Get all products |
| `prodcat:GetProduct` | Get a single product |
| `prodcat:GetAllProducts` | Get all products (unfiltered) |
| `prodcat:GetCategories` | Get product categories |
| `prodcat:GetBrands` | Get product brands |
| `prodcat:FindProducts` | Search products |
| `prodcat:GetProductsByBrand` | Get products by brand |
| `prodcat:GetProductsByCategory` | Get products by category |
| `prodcat:GetProductCatalog` | Get full product catalog |

## Notification

| Command | Description |
|---------|-------------|
| `note:Notify` | Send a notification |
| `note:NotifyCustom` | Send a custom notification |
| `note:Email` | Send an email notification |

---

## Alarm Subsystem

| Command | Description |
|---------|-------------|
| `subalarm:Arm` | **[MCP]** Arm the alarm |
| `subalarm:ArmBypassed` | **[MCP]** Arm with bypass |
| `subalarm:Disarm` | **[MCP]** Disarm the alarm |
| `subalarm:ListIncidents` | **[MCP]** List incidents |
| `subalarm:Panic` | Trigger panic alarm |
| `subalarm:SetProvider` | Set alarm monitoring provider |

## Security Subsystem

| Command | Description |
|---------|-------------|
| `subsecurity:Arm` | Arm security |
| `subsecurity:ArmBypassed` | Arm security with bypass |
| `subsecurity:Disarm` | Disarm security |
| `subsecurity:Panic` | Trigger security panic |
| `subsecurity:Acknowledge` | Acknowledge security alert |

## Alarm Incident

| Command | Description |
|---------|-------------|
| `incident:Verify` | Verify an alarm incident |
| `incident:Cancel` | Cancel an alarm incident |
| `incident:ListHistoryEntries` | List incident history |

## Hub Alarm

| Command | Description |
|---------|-------------|
| `hubalarm:Activate` | Activate hub alarm |
| `hubalarm:Suspend` | Suspend hub alarm |
| `hubalarm:Arm` | Arm hub alarm |
| `hubalarm:Disarm` | Disarm hub alarm |
| `hubalarm:Panic` | Hub alarm panic |
| `hubalarm:ClearIncident` | Clear hub alarm incident |
| `hubalarm:Verified` | Mark incident as verified |

## Care Subsystem

| Command | Description |
|---------|-------------|
| `subcare:ListActivity` | List care activity |
| `subcare:ListDetailedActivity` | List detailed care activity |
| `subcare:ListBehaviors` | List care behaviors |
| `subcare:ListBehaviorTemplates` | List behavior templates |
| `subcare:AddBehavior` | Add a care behavior |
| `subcare:UpdateBehavior` | Update a care behavior |
| `subcare:RemoveBehavior` | Remove a care behavior |
| `subcare:Acknowledge` | Acknowledge care alert |
| `subcare:Clear` | Clear care alert |
| `subcare:Panic` | Trigger care panic |

## Safety Subsystem

| Command | Description |
|---------|-------------|
| `subsafety:Trigger` | Trigger safety alarm |
| `subsafety:Clear` | Clear safety alarm |

## Climate Subsystem

| Command | Description |
|---------|-------------|
| `subclimate:EnableScheduler` | Enable climate scheduler |
| `subclimate:DisableScheduler` | Disable climate scheduler |

## Doors & Locks Subsystem

| Command | Description |
|---------|-------------|
| `subdoorsnlocks:AuthorizePeople` | Authorize people for locks |
| `subdoorsnlocks:SynchAuthorization` | Sync authorization across locks |

## Presence Subsystem

| Command | Description |
|---------|-------------|
| `subspres:GetPresenceAnalysis` | Get who's home analysis |

## Water Subsystem

No client commands — events only (`subwater:ContinuousWaterUse`, `subwater:ExcessiveWaterUse`, `subwater:LowSalt`).

## Weather Subsystem

| Command | Description |
|---------|-------------|
| `subweather:SnoozeAllAlerts` | Snooze all weather alerts |

## Lawn & Garden Subsystem

| Command | Description |
|---------|-------------|
| `sublawnngarden:StartWatering` | Start watering |
| `sublawnngarden:StopWatering` | Stop watering |
| `sublawnngarden:EnableScheduling` | Enable scheduling |
| `sublawnngarden:DisableScheduling` | Disable scheduling |
| `sublawnngarden:SwitchScheduleMode` | Switch schedule mode |
| `sublawnngarden:Skip` | Skip next watering |
| `sublawnngarden:CancelSkip` | Cancel skip |
| `sublawnngarden:ConfigureIntervalSchedule` | Configure interval schedule |
| `sublawnngarden:CreateWeeklyEvent` | Create weekly event |
| `sublawnngarden:UpdateWeeklyEvent` | Update weekly event |
| `sublawnngarden:RemoveWeeklyEvent` | Remove weekly event |
| `sublawnngarden:CreateScheduleEvent` | Create schedule event |
| `sublawnngarden:UpdateScheduleEvent` | Update schedule event |
| `sublawnngarden:RemoveScheduleEvent` | Remove schedule event |
| `sublawnngarden:SyncSchedule` | Sync schedule to device |
| `sublawnngarden:SyncScheduleEvent` | Sync schedule event |
| `sublawnngarden:UpdateSchedule` | Update schedule |
| `sublawnngarden:ApplyScheduleToDevice` | Apply schedule to device |

## Pairing Subsystem

| Command | Description |
|---------|-------------|
| `subpairing:StartPairing` | **[MCP]** Start pairing mode |
| `subpairing:Search` | **[MCP]** Search for devices |
| `subpairing:StopSearching` | Stop searching for devices |
| `subpairing:ListPairingDevices` | List devices being paired |
| `subpairing:ListHelpSteps` | List pairing help steps |
| `subpairing:DismissAll` | Dismiss all pairing devices |
| `subpairing:FactoryReset` | Factory reset a pairing device |
| `subpairing:GetKitInformation` | Get kit information |

## Pairing Device

| Command | Description |
|---------|-------------|
| `pairdev:Customize` | Customize a pairing device |
| `pairdev:AddCustomization` | Add customization |
| `pairdev:Dismiss` | Dismiss a pairing device |
| `pairdev:Remove` | Remove a pairing device |
| `pairdev:ForceRemove` | Force remove a pairing device |

## Cell Backup Subsystem

| Command | Description |
|---------|-------------|
| `cellbackup:Ban` | Ban cell backup |
| `cellbackup:Unban` | Unban cell backup |

## Place Monitor Subsystem

| Command | Description |
|---------|-------------|
| `subplacemonitor:RenderAlerts` | Render monitoring alerts |

## Subsystem (General)

| Command | Description |
|---------|-------------|
| `subs:ListSubsystems` | **[MCP]** List all subsystems |
| `subs:ListHistoryEntries` | List subsystem history |
| `subs:Activate` | Activate a subsystem |
| `subs:Suspend` | Suspend a subsystem |
| `subs:Delete` | Delete a subsystem |

---

## Hub

| Command | Description |
|---------|-------------|
| `place:GetHub` | **[MCP]** Get hub via place |
| `hubadv:Reboot` | **[MCP]** Reboot hub |
| `hubadv:Restart` | Restart hub agent |
| `hubadv:FirmwareUpdate` | Start firmware update |
| `hubadv:GetKnownDevices` | Get known devices from hub |
| `hubadv:GetDeviceInfo` | Get device info from hub |
| `hubadv:Attention` | Set hub attention mode |
| `hubadv:StartUploadingCameraPreviews` | Start camera preview uploads |
| `hubadv:StopUploadingCameraPreviews` | Stop camera preview uploads |
| `hubadv:Deregister` | **[BLOCKED]** Deregister hub |
| `hubadv:FactoryReset` | **[BLOCKED]** Factory reset hub |
| `hub:GetConfig` | Get hub configuration |
| `hub:SetConfig` | Set hub configuration |
| `hub:GetLogs` | Get hub logs |
| `hub:SetLogLevel` | Set hub log level |
| `hub:ResetLogLevels` | Reset hub log levels |
| `hub:StreamLogs` | Stream hub logs |
| `hub:ListHubs` | List hubs |
| `hub:Delete` | **[BLOCKED]** Delete hub |

## Hub Sounds / Chime / Volume

| Command | Description |
|---------|-------------|
| `hubsounds:PlayTone` | Play a tone on the hub |
| `hubsounds:Quiet` | Stop hub sounds |
| `hubchime:chime` | Play chime on hub |

## Hub Backup

| Command | Description |
|---------|-------------|
| `hubbackup:Backup` | Backup hub configuration |
| `hubbackup:Restore` | Restore hub from backup |

## Hub Debug

| Command | Description |
|---------|-------------|
| `hubdebug:GetSyslog` | **[MCP]** Get hub syslog (admin) |
| `hubdebug:GetBootlog` | **[MCP]** Get hub boot log (admin) |
| `hubdebug:GetProcesses` | **[MCP]** Get running processes (admin) |
| `hubdebug:GetLoad` | **[MCP]** Get system load (admin) |
| `hubdebug:GetFiles` | **[MCP]** Get file listing (admin) |
| `hubdebug:GetAgentDb` | **[MCP]** Get agent database (admin) |

## Hub Z-Wave

| Command | Description |
|---------|-------------|
| `hubzwave:NetworkInformation` | **[MCP]** Get Z-Wave network info |
| `hubzwave:Heal` | **[MCP]** Start Z-Wave network heal |
| `hubzwave:CancelHeal` | **[MCP]** Cancel Z-Wave heal |
| `hubzwave:RemoveZombie` | **[MCP]** Remove zombie Z-Wave node |
| `hubzwave:Associate` | Associate Z-Wave node |
| `hubzwave:AssignReturnRoutes` | Assign return routes |
| `hubzwave:ForcePrimary` | Force primary controller |
| `hubzwave:ForceSecondary` | Force secondary controller |
| `hubzwave:Reset` | Reset Z-Wave network |
| `hubzwave:FactoryReset` | Factory reset Z-Wave radio |

## Hub Zigbee

| Command | Description |
|---------|-------------|
| `hubzigbee:NetworkInformation` | **[MCP]** Get Zigbee network info |
| `hubzigbee:GetStats` | **[MCP]** Get Zigbee statistics |
| `hubzigbee:Scan` | **[MCP]** Scan Zigbee network |
| `hubzigbee:GetConfig` | Get Zigbee config |
| `hubzigbee:FormNetwork` | Form new Zigbee network |
| `hubzigbee:Identify` | Identify Zigbee device |
| `hubzigbee:GetNodeDesc` | Get Zigbee node descriptor |
| `hubzigbee:GetActiveEp` | Get active endpoints |
| `hubzigbee:GetSimpleDesc` | Get simple descriptor |
| `hubzigbee:GetPowerDesc` | Get power descriptor |
| `hubzigbee:PairingInstallCode` | Pair with install code |
| `hubzigbee:PairingLinkKey` | Pair with link key |
| `hubzigbee:ClearPendingPairing` | Clear pending pairing |
| `hubzigbee:Remove` | Remove Zigbee device |
| `hubzigbee:FixMigration` | Fix migration issues |
| `hubzigbee:Reset` | Reset Zigbee radio |
| `hubzigbee:FactoryReset` | Factory reset Zigbee radio |

## Hub WiFi

| Command | Description |
|---------|-------------|
| `hubwifi:WiFiStartScan` | Start WiFi scan |
| `hubwifi:WiFiEndScan` | End WiFi scan |
| `hubwifi:WiFiConnect` | Connect to WiFi |
| `hubwifi:WiFiDisconnect` | Disconnect from WiFi |

## Hub 4G

| Command | Description |
|---------|-------------|
| `hub4g:GetInfo` | Get 4G modem info |
| `hub4g:GetStatistics` | Get 4G statistics |
| `hub4g:ResetStatistics` | Reset 4G statistics |

## Hub AV

| Command | Description |
|---------|-------------|
| `hubav:pair` | Pair AV device |
| `hubav:release` | Release AV device |
| `hubav:getIPAddress` | Get AV device IP |
| `hubav:getModel` | Get AV device model |
| `hubav:getState` | Get AV device state |
| `hubav:getVolume` | Get volume |
| `hubav:setVolume` | Set volume |
| `hubav:getMute` | Get mute state |
| `hubav:setMute` | Set mute state |
| `hubav:audioStart` | Start audio |
| `hubav:audioStop` | Stop audio |
| `hubav:audioPause` | Pause audio |
| `hubav:audioSeekTo` | Seek audio position |
| `hubav:audioInfo` | Get audio info |

## Hub Metrics

| Command | Description |
|---------|-------------|
| `hubmetric:ListMetrics` | List available metrics |
| `hubmetric:StartMetricsJob` | Start metrics collection |
| `hubmetric:EndMetricsJobs` | End metrics collection |
| `hubmetric:GetMetricsJobInfo` | Get metrics job info |
| `hubmetric:GetStoredMetrics` | Get stored metrics |

## Hub Network

| Command | Description |
|---------|-------------|
| `hubnet:GetRoutingTable` | Get network routing table |

## Hub Kit

| Command | Description |
|---------|-------------|
| `hubkit:SetKit` | Set hub kit configuration |
