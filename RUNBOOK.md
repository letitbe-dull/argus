# Running Argus

## Options

```sh
argus --port 8766
argus --data-dir "./my settings"
argus --import "./settings.json" --data-dir "./imported"
```

From a source checkout, swap `argus` for `npm start --`, as in `npm start -- --port 8766`. Keep the bare `--`; without it npm takes `--port` for itself.

The port is 8765 unless you set `PORT` or `--port`, and `--port 0` picks any free one. Argus only listens on 127.0.0.1, so the controls and the TV need to be on the same computer.

## Settings

Everything is saved in one `settings.json`:

- Windows: `%APPDATA%\Argus`
- macOS: `~/Library/Application Support/Argus`
- Linux: `~/.config/argus`, or `$XDG_CONFIG_HOME/argus`

`ARGUS_DATA_DIR` or `--data-dir` puts it somewhere else. Stop Argus before you edit the file by hand. If it can't read the file, it keeps a copy as `settings.invalid.*.json` and starts empty.

## When it misbehaves

- Port already in use: another copy is running. Stop it, or pick another port.
- No sound: click once in the TV window, then press listen.
- YouTube won't take a link: it wants a video or live URL, not a channel.
- A stream stops: it retries on its own for a while. After that, press reload.
- Lots of streams stutter: run fewer, or lower the quality in YouTube's settings.
- Controls say reconnecting: the terminal running Argus was closed. Start it again and the windows reconnect.
