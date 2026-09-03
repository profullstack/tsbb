#!/bin/sh
#
# How the container starts.
#
# With no TSBB_CHECKOUT_DIR it runs the code baked into the image, which is
# what an image is for: it is updated by building and deploying a new one.
#
# With TSBB_CHECKOUT_DIR pointing into a volume, the container instead keeps a
# git checkout THERE and runs from it. On first boot it clones the repository
# at the image's own commit and installs from the image's own package store,
# so the first start needs no download and passes the healthcheck like any
# other. From then on the board updates itself: the server fetches each new
# release into the checkout, exits, and this script starts it again from the
# new code — so a board on a platform that only redeploys images still follows
# releases within minutes, and survives a container restart because the
# checkout is on the volume, not in the container.
set -eu

IMAGE_ROOT="${TSBB_IMAGE_ROOT:-/app}"
DIR="${TSBB_CHECKOUT_DIR:-}"
REPO="${TSBB_UPDATE_REPO:-profullstack/tsbb}"

if [ -z "$DIR" ]; then
  cd "$IMAGE_ROOT"
  exec node apps/server/src/index.ts
fi

if [ ! -d "$DIR/.git" ]; then
  echo "[tsbb] first boot: cloning $REPO into $DIR"
  rm -rf "$DIR"
  git clone --quiet "https://github.com/$REPO" "$DIR"
  # Start from exactly the commit this image was built from, so the checkout
  # and the image agree, so the install below finds everything in the store.
  if [ -n "${RAILWAY_GIT_COMMIT_SHA:-}" ]; then
    git -C "$DIR" -c advice.detachedHead=false checkout --quiet "$RAILWAY_GIT_COMMIT_SHA" \
      || echo "[tsbb] commit ${RAILWAY_GIT_COMMIT_SHA} is not in the clone; staying on the default branch"
  fi
  # The image's install left every package in pnpm's store, so linking them
  # into the new checkout is seconds and needs no network. Copying the image's
  # node_modules instead does not work: pnpm sees a tree made for another path
  # and stops to ask whether it may rebuild it. CI=true is the "yes" it wants
  # if the lockfile has drifted and it must.
  echo "[tsbb] installing dependencies from the image's store"
  ( cd "$DIR" && CI=true pnpm install --frozen-lockfile --ignore-scripts --offline ) \
    || ( cd "$DIR" && CI=true pnpm install --frozen-lockfile --ignore-scripts )
fi

cd "$DIR"
echo "[tsbb] running from $DIR at $(git rev-parse --short HEAD) ($(git describe --tags --always 2>/dev/null))"

# The updater exits after installing a release; this loop is the supervisor
# that brings the new code up. A crash waits a few seconds so a broken build
# cannot spin the container.
export TSBB_RESTART=exit
while :; do
  if node apps/server/src/index.ts; then
    echo "[tsbb] server exited; starting again from $(git rev-parse --short HEAD)"
  else
    code=$?
    echo "[tsbb] server exited with status $code; starting again in 5s"
    sleep 5
  fi
done
