# SCLI Bridge

Exposes Savant's `sclibridge` command-line tool on the network, so other devices and scripts
can read and write Savant state and trigger service requests without shell access to the
Pro Host.

## Ports

| Port | |
|---|---|
| 12000 | Clients send one command per connection: a raw line ending in `\n`, or an HTTP GET |
| 12001 | The Savant host connects here using the **IP Requests** profile (`profiles/ip_requests.xml`) and holds the connection open. SplycedBoard tracks it for status. Commands run through `sclibridge`. |

## Commands

Only these are accepted; anything else is dropped without a reply:
`readstate`, `writestate`, `servicerequest`, `servicerequestcommand`, `userzones`,
`statenames`, `settrigger`, `removetrigger`.

```bash
# raw TCP
printf 'readstate userDefined.vacation_mode_status\n' | nc <pro-host-ip> 12000

# HTTP
curl 'http://<pro-host-ip>:12000/readstate%20userDefined.vacation_mode_status'

# service request: arguments after ':' become name/value pairs
printf 'servicerequestcommand Den-AppleTV-1-SVC_AV_TV-PowerOn:Level=50\n' | nc <pro-host-ip> 12000
```

The dashboard's **SCLI Bridge** page runs commands too.

## Settings (optional)

`data/scli/settings.json`: `sclibridgePath` (if `sclibridge` isn't in a standard location),
`clientPort`, `savantPort`.

`sclibridge` is looked for at `/Users/Shared/Savant/Applications/RacePointMedia/sclibridge`,
`~/Applications/RacePointMedia/sclibridge` and `/usr/local/bin/sclibridge`.
