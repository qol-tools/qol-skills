# Parallel UI lanes on nested displays

Use this when several agents, or one agent with several scenarios, must drive plugin windows at the same time and the host can afford one guest, not one per lane.

## Shape

One guest, one tray on `:0`, one nested Xephyr X server per lane with its own metacity. Every X server owns its keyboard focus, pointer and active window, so `xdotool` on `:N` reaches only lane N, and focus thieves on `:0` (mintupdate, the panel) never touch a lane. Ten lanes ran at once in one guest; six typing different sequences concurrently ended in six distinct states.

One tray per guest is a hard limit: it binds the fixed `DEFAULT_PORT` as its single-instance probe (`apps/tray/src/single_instance/platform/port_probe.rs`), config and token live under the fixed `qol-tray` namespace, and plugin daemons bind the fixed ports from `plugin.toml`.

## Recipe

Everything runs through `qol env exec <run> /bin/sh -c '...'` as the guest desktop user.

1. Size the guest for the lanes: `qol env up linux/mint-cinnamon --dev-worktree <worktree> --cpus 6 --memory-mb 4096` carries ten lanes. The default 2 vCPU and 3 GB hold about nine idle lanes but only two busy ones.
2. Start each lane as systemd user units, never as plain exec children: `RequestAction::Spawn` children die when the control connection drops (`ProcessManager::drop` in `libs/dev-guest/src/server.rs`).

   ```sh
   systemd-run --user --quiet --unit qol-display-N --setenv=DISPLAY=:0 Xephyr :N -screen 1100x700 -ac -br -noreset -nolisten tcp -title laneN
   until DISPLAY=:N xdpyinfo >/dev/null 2>&1; do sleep 0.02; done
   systemd-run --user --quiet --unit qol-display-N-wm --setenv=DISPLAY=:N metacity --replace
   until DISPLAY=:N xprop -root _NET_SUPPORTING_WM_CHECK | awk '/window id/{f=1} END{exit !f}'; do sleep 0.02; done
   systemd-run --user --quiet --unit qol-display-N-app --setenv=DISPLAY=:N --setenv=LP_NUM_THREADS=1 <plugin-binary> <args>
   DISPLAY=:0 xdotool search --name laneN windowminimize
   ```

   A lane is ready once `_NET_SUPPORTING_WM_CHECK` is set, under a second after the first unit. `LP_NUM_THREADS=1` is not optional: gpui's software rasteriser otherwise spins one thread per vCPU and one busy lane eats most of the guest. Minimising the Xephyr host window on `:0` removes the Cinnamon compositing cost; the lane still renders and captures.
3. Drive lane N with `DISPLAY=:N xdotool ...` and find its window with `DISPLAY=:N xdotool search --name '^Explorer'`.
4. Capture lane N inside the guest and carry the PNG out over the exec channel, because `qol env shot` sees only `:0`:

   ```sh
   DISPLAY=:N ffmpeg -loglevel error -f x11grab -video_size 1100x700 -i :N -frames:v 1 -y /tmp/laneN.png
   base64 -w0 /tmp/laneN.png
   ```

   Drop the exec banner lines before decoding on the host.
5. Tear down in order: the app unit, then the WM unit, then the display unit. Stopping all three at once leaves the WM units `failed`.

## Costs

Measured in `mint-22.3-cinnamon-6.6.7-qol-2` (the `image_revision` in `flows/envs/linux-mint-cinnamon.toml`) with the explorer. Measure again when that revision or gpui's rasteriser changes.

- Memory: about 115 MB per lane (Xephyr 27, metacity 18, the explorer 65 MB PSS).
- CPU: under 1 % idle, about 0.85 vCPU per continuously busy lane with `LP_NUM_THREADS=1`. Agents think between actions, so ten lanes fit 6 vCPU.
- Ready in under 0.9 s; one capture costs about 250 ms.
- Xephyr, metacity, xdotool, xprop and ffmpeg with x11grab are in the image. Xvfb and ImageMagick are not, and are not needed.

## What a lane cannot test

- Daemon-backed surfaces (alt-tab, launcher, qol-shot) and global hotkeys: a daemon holds one X connection, and an X grab on `:N` sees only `:N`. They stay on `:0`.
- Tray-route dispatch: a lane starts the plugin binary, the CLI-inline path. For a runtime command with no daemon, such as the explorer's `open`, that matches the tray route except for the environment. For anything else, trigger on `:0` through the tray action endpoint.
- Cinnamon itself: lanes run metacity. The panel, Cinnamon placement rules and its compositor need `:0`.
- Monitor size: a lane is 1100x700 unless `-screen` says otherwise. The explorer's 1040x640 window lands at 60,53 under metacity, so that screen clips its bottom 53 px: give `-screen` 1200x800 (and the capture `-video_size` to match) or move the window to 0,0 with `xdotool windowmove`.

## Extending

Grow the CLI at its owners instead of a wrapper script: `qol env exec --display :N` overrides `DISPLAY` in `tools/cli/src/commands/emu/control.rs` `cmd_exec`; `qol env display up|down` belongs beside `tools/cli/src/commands/env/dev_session.rs`, which already starts guest user units; `qol env shot --display :N` wants a typed capture action in `libs/dev-guest`. Lanes then record their `display` and shot paths in `report.json`.
