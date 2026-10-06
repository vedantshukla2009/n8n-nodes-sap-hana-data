ARG N8N_VERSION=2.29.8
FROM node:22-alpine AS dependencies
WORKDIR /opt/hana
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --legacy-peer-deps
COPY dist ./dist
FROM docker.n8n.io/n8nio/n8n:${N8N_VERSION}
USER root
RUN ["node", "-e", "const f=require('fs');if(process.arch==='x64'&&f.existsSync('/lib/ld-musl-x86_64.so.1')&&!f.existsSync('/usr/local/bin/ldd'))f.symlinkSync('/lib/ld-musl-x86_64.so.1','/usr/local/bin/ldd')"]
COPY --from=dependencies /opt/hana /opt/hana
RUN ["node", "-e", "require('fs').symlinkSync('/usr/local/lib/node_modules/n8n/node_modules/n8n-workflow','/opt/hana/node_modules/n8n-workflow');console.log(require('/opt/hana/node_modules/@sap/hana-client').getDriverVersion())"]
USER node
