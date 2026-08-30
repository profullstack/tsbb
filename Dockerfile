# tsbb runs its TypeScript unbuilt through Node's type stripping, so there is no
# build stage here at all — only install, then run.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

RUN corepack enable

# The whole tree is copied before installing rather than listing each workspace
# manifest by hand. Listing them is faster to rebuild and silently wrong: a new
# package is invisible to pnpm until it happens to gain an external dependency.
COPY . .

RUN pnpm install --frozen-lockfile --ignore-scripts

# The container holds no state at all: uploads live in the database alongside
# everything else, so there is no volume to attach and no reason the service
# cannot run more than one replica.

EXPOSE 3000

# Migrations run at boot inside the server, so a deploy can never leave new code
# running against an old schema.
CMD ["node", "apps/server/src/index.ts"]
