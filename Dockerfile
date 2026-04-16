FROM node:20-alpine

WORKDIR /app

# Install build dependencies for opusscript (native addon)
RUN apk add --no-cache python3 make g++ ffmpeg

# Copy a standalone package.json (no pnpm workspace catalog refs)
COPY docker-package.json package.json

RUN npm install --omit=dev

# Copy source
COPY src/ src/
COPY tsconfig.json .

# Build TypeScript
RUN npm install tsx typescript --save-dev && npx tsc && npm uninstall tsx typescript

EXPOSE 3000

CMD ["node", "dist/index.js"]
