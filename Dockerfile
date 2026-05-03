FROM node:18-alpine

# Устанавливаем build-зависимости для better-sqlite3
RUN apk add --no-cache python3 make g++

# Рабочая директория
WORKDIR /app

# Копируем package.json и устанавливаем зависимости
COPY package.json ./
RUN npm install --production

# Копируем весь код
COPY . .

# Создаём директорию для БД
RUN mkdir -p /app/data

# Порт
EXPOSE 8080

# Запуск
CMD ["node", "server.js"]
