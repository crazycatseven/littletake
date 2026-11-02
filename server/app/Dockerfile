FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production LITTLETAKE_HOST=0.0.0.0 PORT=8080 LITTLETAKE_DATA_DIR=/data
EXPOSE 8080
CMD ["npm", "start"]
