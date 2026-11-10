from .pedidos import ESTADOS


def descuento_cliente(cliente, total):
    if cliente.get("estado") not in ESTADOS:
        return 0
    return total * 0.05 if cliente["tipo"] == "premium" else 0


def resumen_cliente(cliente, pedidos):
    lineas = []
    importe = 0
    for pedido in pedidos:
        for item in pedido["items"]:
            subtotal = item["precio"] * item["cantidad"]
            if item.get("descuento"):
                subtotal -= subtotal * item["descuento"]
            importe += subtotal
            lineas.append(f'{item["nombre"]}: {subtotal:.2f}')
    lineas.append(f"Total: {importe:.2f}")
    return f'Cliente {cliente["nombre"]}\n' + "\n".join(lineas)
