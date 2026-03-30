FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
RUN npm install --production=false

COPY . .

EXPOSE 5000
ENV PORT=5000
ENV PO_ENV=prod

CMD ["npx", "tsx", "index.ts"]
