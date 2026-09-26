# UniFi Protect cameras in Savant

A standalone Savant profile for cameras adopted in UniFi Protect (G6, and the G5, G4 and AI
models too), separate from the SplycedBoard service: `ubiquiti_unifi protect camera (splyced).xml`.

Savant's own UniFi profiles stream from the camera itself (`/s1`, `/s2`), which a camera adopted
in Protect doesn't offer. Protect streams each camera from the console instead, at an address
with a token of its own. This profile takes that address, one component per camera, with the
token typed into the camera's IP Address field. The profile itself stays the same for every
camera.

## Setup

1. **Protect:** open the camera → Settings → Advanced, and turn on RTSP for the quality you
   want (High is usual). Protect shows something like
   `rtsps://192.168.5.1:7441/Esg1HhMEGKeVBUnU?enableSrtp`. The part between the last `/` and
   the `?` (`Esg1HhMEGKeVBUnU`) is that camera's stream token.
2. **Blueprint:** add the profile to your library (Preferences), then one **UniFi Protect Camera
   (Splyced)** component per camera. In the Security Camera data table, set each camera's
   **IP Address** to the console's address, port **7447**, and its token:

   ```
   192.168.5.1:7447/Esg1HhMEGKeVBUnU
   ```

   Leave the user name and password empty.
3. Upload the configuration.

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
- **The path is `?`.** Blueprint puts the profile's path right after the IP Address field. Protect
  refuses `…/token/` (a trailing slash) but ignores an empty query, so `?` keeps the path
  from being empty without changing the address.
- **H.264.** Savant's camera profiles play H.264. A camera with Protect's Enhanced Encoding on
  streams H.265: if the tile stays black in the Savant app, turn Enhanced Encoding off for that
  camera.
- **One stream per camera.** The thumbnail and fullscreen views play the same stream. With many
  cameras on screen, the Medium or Low stream's token is lighter.

## Checked

Against a Protect console on the Beta Host's network (192.168.5.1): `rtsp://192.168.5.1:7447/<token>`
and `…/<token>?` answer; `…/<token>/` doesn't; with `?enableSrtp` the stream description carries
SRTP keys (`a=crypto`); a login in the address is ignored; with Enhanced Encoding off, a G6
streams H.264. Still to check in Savant: that Blueprint builds `rtsp://192.168.5.1:7447/<token>?`
from the IP Address field, and the picture in the Savant app.
