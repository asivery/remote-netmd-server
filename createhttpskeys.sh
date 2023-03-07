#!/bin/sh
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -sha256 -days 99999 -nodes -subj '/CN=remotemd'
