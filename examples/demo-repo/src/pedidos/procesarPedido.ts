import { calcularDescuento } from '../clientes/descuentos';
import { formatearMoneda } from '../util/formato';

export interface Pedido {
  id: string;
  cliente: { tipo: string; antiguedad: number; pais: string };
  items: Array<{ precio: number; cantidad: number; categoria: string }>;
  cupon?: string;
}

// FIXME: esta función creció sin control, dividir por responsabilidades
export function procesarPedido(pedido: Pedido, impuesto: number, envio: number, moneda: string, urgente: boolean, regalo: boolean): string {
  let total = 0;
  for (const item of pedido.items) {
    if (item.cantidad > 0) {
      if (item.categoria === 'electronica') {
        if (item.precio > 1000) {
          if (pedido.cliente.tipo === 'premium') {
            if (pedido.cliente.antiguedad > 5) {
              total += item.precio * item.cantidad * 0.85;
            } else {
              total += item.precio * item.cantidad * 0.9;
            }
          } else {
            total += item.precio * item.cantidad;
          }
        } else {
          total += item.precio * item.cantidad;
        }
      } else if (item.categoria === 'ropa' || item.categoria === 'calzado') {
        total += item.precio * item.cantidad * (pedido.cliente.pais === 'CO' ? 0.95 : 1);
      } else if (item.categoria === 'alimentos' && item.cantidad > 10) {
        total += item.precio * item.cantidad * 0.97;
      } else {
        total += item.precio * item.cantidad;
      }
    }
  }
  if (pedido.cupon && pedido.cupon.startsWith('VIP')) total *= 0.9;
  else if (pedido.cupon === 'BIENVENIDA') total *= 0.95;
  total -= calcularDescuento(pedido.cliente.tipo, total);
  total += urgente ? envio * 2 : envio;
  total += regalo ? 5000 : 0;
  total *= 1 + impuesto;
  return formatearMoneda(total, moneda);
}
