# UniFi Protect cameras in Savant

A standalone Savant profile for cameras adopted in UniFi Protect (G6, and the G5, G4 and AI
models too), separate from the SplycedBoard service: `ubiquiti_unifi protect camera (splyced).xml`.

Savant's own UniFi profiles stream from the camera itself (`/s1`, `/s2`), which a camera adopted
in Protect doesn't offer. Protect streams each camera from the console instead, at an address
with a token of its own. This profile takes that address, one component per camera, with the
token typed into the camera's IP Address field. The profile itself stays the same for every
camera.

## Setup

1. **Protect, Recording Manager:** set the camera's stream to **Standard**. Savant plays H.264;
   **Enhanced** streams H.265, and the camera stays black in the Savant app.
2. **Protect:** open the camera → Settings → Advanced, and turn on RTSP for the quality you
   want (High is usual). Protect shows something like
   `rtsps://192.168.5.1:7441/Esg1HhMEGKeVBUnU?enableSrtp`. The part between the last `/` and
   the `?` (`Esg1HhMEGKeVBUnU`) is that camera's stream token.
3. **Blueprint:** add the profile to your library (Preferences), then one **UniFi Protect Camera
   (Splyced)** component per camera. Savant takes a camera's address from its camera table
   (Camera, Logical Component, IP Address, User Login, Password, Enable H.264), not from the
   network connection. For each camera there:

   | | |
   |---|---|
   | IP Address | the console's address, port **7447**, and its token, **without** `rtsp://` (Savant adds it): `192.168.5.1:7447/Esg1HhMEGKeVBUnU` |
   | User Login, Password | empty |
   | Enable H.264 | on: this profile's streams are H.264 only |
4. Upload the configuration.

## Why it's built like this

- **The token can't be a state variable.** Blueprint writes each camera's stream address once,
  when it builds the configuration: the data table's IP Address (and login) followed by a fixed
  path from the profile. The Savant app then opens that address itself, straight from the
  iPad or TV, so the Savant host, where state variables live, is never involved. (A Samsung
  TV's AccessToken works as a state variable because the host puts it into each command it
  sends.) So the one thing that differs per camera goes in the IP Address field.
- **Port 7447, not 7441.** Protect serves every stream twice: encrypted on 7441 (`rtsps://`,
  and `?enableSrtp` encrypts the video too) and plain on 7447. Blueprint only builds `rtsp://`
  addresses, and `?enableSrtp` switches on SRTP even on 7447, so neither works in Savant.
  Plain RTSP on 7447 needs no login; the token is the only key.
- **The path is `/`.** Blueprint builds `rtsp://` + the IP Address joined to the profile's path
  the way macOS joins file paths: it puts a `/` between them and collapses `//`. Joining `/`
  adds nothing, so the address comes out exactly as typed. (Version 1.0–1.2 used `?`, which
  came out as `…/token/?`: Protect refuses it. And `rtsp://` typed into the IP Address comes
  out as `rtsp://rtsp:/…`.)
- **Standard, not Enhanced.** Savant's camera profiles play H.264. Protect's Recording Manager
  streams a camera set to Enhanced as H.265 (same token, different video), which Savant can't
  show; Standard is H.264.
- **One stream per camera.** The thumbnail and fullscreen views play the same stream. With many
  cameras on screen, the Medium or Low stream's token is lighter.

## Checked

Against a Protect console on the Beta Host's network (192.168.5.1): `rtsp://192.168.5.1:7447/<token>`
and `…/<token>?` answer; `…/<token>/` doesn't; with `?enableSrtp` the stream description carries
SRTP keys (`a=crypto`); a login in the address is ignored; set to Standard, a G6 streams
H.264 (Enhanced: H.265). On the Beta Host, Blueprint compiled version 1.2 with
`rtsp://192.168.5.1:7447/<token>` typed in as `rtsp://rtsp:/192.168.5.1:7447/<token>/?`, which is
how the joining above was found. Still to check in Savant: 1.3 with the address typed
without `rtsp://`, and the picture in the Savant app.
