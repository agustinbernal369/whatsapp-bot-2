FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

ENV NODE_OPTIONS="--max-old-space-size=360 --expose-gc"

CMD ["npm", "start"]
