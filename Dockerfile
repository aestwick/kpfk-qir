FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
ARG NEXT_PUBLIC_SUPABASE_URL=https://czjhwhfqohpmwprhasve.supabase.co
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_URL=https://qir.kpfk.org
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
RUN npm run build
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1
CMD ["npm", "run", "start:all"]
