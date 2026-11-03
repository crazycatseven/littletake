FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
RUN npx playwright-core install chrome
COPY . .
RUN npm run build
ENV NODE_ENV=production REFERENCE_HOST=0.0.0.0 PORT=8080 REFERENCE_DATA_DIR=/data REFERENCE_CALL_LIMIT=72 REFERENCE_CHROME_CHANNEL=chrome
EXPOSE 8080
CMD ["npm", "run", "jobs"]
