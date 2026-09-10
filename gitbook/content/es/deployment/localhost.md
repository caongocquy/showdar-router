# 🏠 Despliegue en localhost

Ejecuta Showdar Router en tu máquina local para desarrollo y uso personal.

---

## 📦 Instalación

Instala Showdar Router globalmente vía npm:

```bash
npm install -g showdar-router
```

**Requisitos:**
- Node.js 20 o superior
- npm 9 o superior

---

## 🚀 Iniciar el servidor

Inicia Showdar Router con un solo comando:

```bash
showdar-router
```

El dashboard se abrirá automáticamente en tu navegador en `http://localhost:3000`

**Configuración por defecto:**
- **Dashboard**: `http://localhost:3000`
- **API Endpoint**: `http://localhost:20129/v1`
- **Directorio de datos**: `~/.showdar-router`

---

## 🔧 Configuración

### Directorio de datos personalizado

Establece un directorio de datos personalizado usando una variable de entorno:

```bash
DATA_DIR=/path/to/data showdar-router
```

### Puerto personalizado

El puerto de API (20129) y el puerto del dashboard (3000) están configurados en la aplicación. Para cambiarlos, necesitarás modificar el código fuente o usar variables de entorno si se soportan.

---

## 🛑 Detener el servidor

Presiona `Ctrl+C` en la terminal donde Showdar Router se está ejecutando.

```bash
# En la terminal ejecutando showdar-router
^C  # Presiona Ctrl+C
```

El servidor se apagará correctamente y guardará todos los datos.

---

## 🔄 Reiniciar el servidor

Simplemente ejecuta el comando de inicio nuevamente:

```bash
showdar-router
```

Todas tus configuraciones, API keys y combos se preservan en el directorio de datos.

---

## 📊 Actualizar Showdar Router

Actualiza a la última versión:

```bash
npm update -g showdar-router
```

Verifica tu versión actual:

```bash
npm list -g showdar-router
```

---

## 🔍 Solución de problemas

### Puerto ya en uso

Si el puerto 20129 o 3000 ya está en uso:

```bash
# Encontrar proceso usando el puerto (macOS/Linux)
lsof -i :20129
lsof -i :3000

# Matar el proceso
kill -9 <PID>
```

### Errores de permisos

Si encuentras errores de permisos durante la instalación:

```bash
# Usar sudo (no recomendado)
sudo npm install -g showdar-router

# O corregir los permisos de npm (recomendado)
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
```

### Problemas con el directorio de datos

Si el directorio de datos no es accesible:

```bash
# Verificar permisos
ls -la ~/.showdar-router

# Corregir permisos
chmod 755 ~/.showdar-router
```

---

## 📁 Estructura del directorio de datos

```
~/.showdar-router/
├── db.json           # Main database (providers, combos, settings)
├── logs/             # Application logs
└── cache/            # Temporary cache files
```

**Respaldar tus datos:**

```bash
# Respaldo
cp -r ~/.showdar-router ~/.showdar-router.backup

# Restaurar
cp -r ~/.showdar-router.backup ~/.showdar-router
```

---

## 🔗 Próximos pasos

- [Conectar proveedores](/providers/subscription.md)
- [Crear combos](/features/combos.md)
- [Integrar con herramientas CLI](/integration/cursor.md)
