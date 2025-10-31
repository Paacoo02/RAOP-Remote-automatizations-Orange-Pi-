#!/bin/bash
echo "🧹 Limpiando fingerprint SSH para localhost:2222 ..."
ssh-keygen -R "[localhost]:2222" 2>/dev/null || true
ssh-keygen -R "127.0.0.1:2222" 2>/dev/null || true
echo "✅ Limpieza de claves SSH completada."
