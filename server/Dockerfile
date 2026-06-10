FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm install

FROM deps AS build
COPY web web
RUN npm run web:build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
RUN npm install --omit=dev --workspace server
COPY server server
COPY --from=build /app/web/dist web/dist
EXPOSE 8787
CMD ["npm", "run", "server:start"]
