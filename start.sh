docker stop showdar-router
docker rm showdar-router
docker build -t showdar-router .
docker run -d --name showdar-router -p 21298:21298 --env-file .env -v showdar-router-data:/app/data showdar-router
