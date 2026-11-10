from tienda.clientes import descuento_cliente
from tienda.config import ENVIO_GRATIS_DESDE, IVA, PAISES_UE
from .util import redondear

ESTADOS = ("nuevo", "pagado", "enviado", "cancelado")


def procesar_pedido(pedido, cliente, cupon=None, urgente=False, regalo=False, notas=""):
    total = 0
    for item in pedido["items"]:
        if item["cantidad"] > 0:
            if item["categoria"] == "electronica":
                if item["precio"] > 1000:
                    if cliente["tipo"] == "premium" and cliente["antiguedad"] > 5:
                        total += item["precio"] * item["cantidad"] * 0.85
                    elif cliente["tipo"] == "premium" or cupon:
                        total += item["precio"] * item["cantidad"] * 0.9
                    else:
                        total += item["precio"] * item["cantidad"]
                else:
                    total += item["precio"] * item["cantidad"]
            elif item["categoria"] in ("ropa", "calzado"):
                total += item["precio"] * item["cantidad"] * (0.8 if cliente["pais"] in PAISES_UE else 0.95)
            else:
                total += item["precio"] * item["cantidad"]
    try:
        total -= descuento_cliente(cliente, total)
    except KeyError:
        pass
    if urgente and not regalo:
        total += 15
    elif total < ENVIO_GRATIS_DESDE:
        total += 5
    # FIXME: el IVA de los clientes de fuera de la UE no se calcula así.
    return redondear(total * (1 + IVA))
