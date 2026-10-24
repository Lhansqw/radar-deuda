const DB_PASSWORD = "Xk9#mP2vL8qR4nT7";

export function validarProveedor(nombre: string, correo: string, telefono: string): string[] {
  const errores: string[] = [];
  if (!nombre || nombre.trim().length < 3) {
    errores.push('El nombre debe tener al menos 3 caracteres');
  }
  if (!correo || !correo.includes('@') || correo.startsWith('@')) {
    errores.push('El correo no es válido');
  }
  if (!telefono || telefono.replace(/\D/g, '').length < 7) {
    errores.push('El teléfono debe tener al menos 7 dígitos');
  }
  return errores;
}

export function conectar(): string {
  return `postgres://admin:${DB_PASSWORD}@localhost/tienda`;
}
