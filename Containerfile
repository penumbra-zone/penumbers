# Provide specific arg for setting the version of nodejs to use.
# Should match what's in flake.nix for development.
ARG NODE_MAJOR_VERSION=20
FROM docker.io/node:${NODE_MAJOR_VERSION}-alpine AS base
# Install dependencies only when needed
FROM base AS deps
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
# Right now the repo prefers `npm` rather than `pnpm`
# COPY package.json pnpm-lock.yaml* ./
# RUN corepack enable pnpm && pnpm install --frozen-lockfile
RUN npm install --frozen-lockfile

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build the website as standalone output.
RUN npm --version && node --version
RUN npm run build

# Production image, copy all the files and run next
FROM base AS runner
LABEL maintainer="team@penumbralabs.xyz"
WORKDIR /app

ENV NODE_ENV production

# Create normal user for app
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nodejs

COPY --from=builder --chown=nodejs:nodejs /app /app

USER nodejs
EXPOSE 3000
ENV PORT 3000

CMD HOSTNAME="0.0.0.0" npm start
