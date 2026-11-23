# Static marketing site (skydra.eu) on Cloud Run: unprivileged nginx serving site/ on port 8080.
FROM nginxinc/nginx-unprivileged:1.29.3-alpine
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY site/ /usr/share/nginx/html/
