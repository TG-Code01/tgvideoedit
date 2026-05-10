FROM python:3.11-slim

# Install ffmpeg
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy all app files
COPY . .

# Create required directories
RUN mkdir -p uploads output

# Expose port (Railway sets PORT env var)
EXPOSE 8765

CMD ["python", "webapp.py"]
