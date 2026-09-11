# Updates

A tsbb board keeps itself current. A minute after it starts, and every five
minutes after that, it asks GitHub for the newest release of
[profullstack/tsbb](https://github.com/profullstack/tsbb); when there is one it
fetches the tag, runs `pnpm install --frozen-lockfile --ignore-scripts`, and
restarts itself.

That is the three commands you would otherwise type. A self-hosted board that
nobody types them for is how every forum ends up three years behind, which is a
security problem long before it is a features problem.

## Controlling it

It is on by default. An administrator turns it off under **Board settings ->
Updates**, and the overview page always shows what is running, what is out, and
a **Check now** button. With automatic updates off it also offers **Update now**.

From a shell:

```
tsbb update --check     # what is running, what is out
tsbb update             # fetch the newest release tag, install, and stop
```

| Setting | |
|---|---|
| `updates.auto` | Whether a board applies what it finds. On by default. |
| `TSBB_UPDATES=off` | Disables the check entirely, for a board whose deployment owns its version. |
| `TSBB_RESTART=exit` | Exit instead of respawning, for systemd, pm2 or anything else that restarts a process. |
| `TSBB_CHECKOUT_DIR` | A directory on a volume: the container runs, and updates, a checkout there. |

## Two things it will not do

**It never touches a checkout with local changes.** That is somebody's work. It
stops and says so.

**It never updates an image.** A Docker image has no `.git` to move, so a board
running the image's own code sees the notice and is updated by redeploying,
which is how those platforms expect it anyway.

## A container that updates itself

A container can keep itself current if it has a volume. Set `TSBB_CHECKOUT_DIR`
to a directory on it (`/app/data/app`, say) and the container clones the
repository there on first boot, at the image's own commit, with dependencies
linked from the image's package store, so the first start is as fast as any
other. It then runs from that checkout. Each release is fetched into the volume
and the server restarted from it, so a container restart comes back on the
release it had rather than the image it was built from.

`bbs.hqtui.com` runs this way.

## What a release is

A tsbb release is a git tag and a GitHub release, not an npm publish. Boards
install from a checkout, so the tag is the delivery mechanism: a board is
running whatever release it last fetched, and `tsbb update --check` will tell
you which.
