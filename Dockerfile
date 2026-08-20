FROM mcr.microsoft.com/playwright:v1.61.0-noble

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

EXPOSE 8080

CMD ["npm", "run", "start"]
