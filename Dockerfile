# Use official Playwright base image (includes Chromium + dependencies)
FROM mcr.microsoft.com/playwright:v1.40.1-jammy

WORKDIR /app

# Copy package info first for caching
COPY package.json package-lock.json ./

RUN npm install

# Copy the rest of your project
COPY . .

# Cloud Run sets PORT automatically (must NOT hardcode)
ENV PORT=8080

EXPOSE 8080

CMD ["npm", "start"]

