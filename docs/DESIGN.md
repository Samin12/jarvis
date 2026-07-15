# Jarvis interface system

## Product posture

Jarvis should feel like a quiet instrument panel, not a chat website in costume. The center is an
ambient system state; useful evidence lives at the edges; consequential actions interrupt with a
clear approval surface.

## First-run states

1. **Checking:** never flash a login button before the isolated account check finishes.
2. **Signed out:** one primary action, **Continue with ChatGPT**, plus the truthful promise that no
   API key is required.
3. **Authorizing:** explain that the browser owns sign-in; offer **Reopen sign-in** without starting
   parallel OAuth flows.
4. **Securing session:** distinguish browser approval from the local account-read step.
5. **Ready:** show identity, voice lane, Apps, conversation, mission, and bounded Codex tasks.

## Visual language

- Near-black stage with a volumetric graph core; edge scrims preserve legibility without dashboard
  card clutter.
- Big Shoulders for identity and clock; Martian Mono for state, controls, evidence, and receipts.
- A slowly traveling accent hue gives the system life. Listening remains cobalt, speaking remains
  warm, and error remains fixed red so semantics do not drift with decoration.
- Minimum main window: 1120×720. At smaller desktop widths, side zones compact before the mission
  or voice control loses priority.
- Reduced-motion preference collapses animations and transitions.

## Voice behavior

- **Engage** is the explicit permission-producing action.
- LIVE is the signed-in default: Space gates the WebRTC microphone and typed input remains
  available.
- LOCAL starts automatically if LIVE fails: hold Space to start native recognition, release to
  finalize, and blur to cancel.
- A lane change is stated in the transcript; there is no API-key setup or hidden retry loop.
- The microphone dot follows authoritative helper/session events, never optimistic button state.
- Permission denial is recoverable: typed conversation remains usable and the UI says why voice is
  unavailable.

## Approval behavior

An approval must show the operation, target, capability, data class, reason, and expiry.
Assistant-originated Codex handoff shows the complete prompt and selected folder. Workspace-write
approval shows the file path, change type, and untruncated diff/full replacement content. If that
exact preview cannot be constructed, dispatch is denied. Approval is one-shot and bound to
account, process generation, provider generation, workspace identity, and intent hash. Closing,
expiring, logging out, or changing context denies it. Model prose cannot approve anything.

For the computer lane, copy uses the human app name (`Open Calendar`) and shows the fixed system
path. The only choices are allow once or deny; Jarvis never offers a session-wide grant.

## Codex handoff behavior

- The folder chooser is a native, host-owned action. After a folder is selected, panel Run and an
  explicit spoken or typed request can dispatch the same bounded task lane.
- The assistant supplies prompt text only. It never sees or proposes a path, scope ID, or folder
  capability. Since connected-app text is untrusted, assistant-originated dispatch shows a
  one-shot exact prompt + selected-folder approval. A tool success means **dispatched**, not
  **completed**.
- If no folder is active, Jarvis asks the user to choose one in the Codex panel. If the account has
  no durable action principal, folder selection and Run remain disabled while Chat and Apps remain
  usable.

## Outcome language

- **SUCCESS:** a trusted postcondition was verified.
- **BLOCKED:** policy, provider, user denial, or safe eligibility prevented the action.
- **OUTCOME UNKNOWN:** dispatch occurred but the host cannot prove the final state. Never soften
  this into success copy.

## Accessibility

- All primary controls are real buttons or form inputs with names and focus states.
- Color is paired with text and shape.
- Permission and action errors use live regions without taking keyboard focus.
- Push-to-talk ignores typing targets, cancels on blur, and keeps typed input as a fallback.
