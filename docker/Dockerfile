# Production base-image adjustment. Install the packaged community node into the
# shared n8n user directory as usual, then restart main and every worker.
ARG N8N_VERSION=2.29.8
FROM docker.n8n.io/n8nio/n8n:${N8N_VERSION}
USER root
RUN ["node", "-e", "const f=require('fs');if(process.arch==='x64'&&f.existsSync('/lib/ld-musl-x86_64.so.1')&&!f.existsSync('/usr/local/bin/ldd'))f.symlinkSync('/lib/ld-musl-x86_64.so.1','/usr/local/bin/ldd')"]
USER node
