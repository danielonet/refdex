/** A customer order. */
export interface Order {
  id: string;
  lines: { sku: string; qty: number }[];
  total(): number;
}

export class OrderModel implements Order {
  id = '';
  lines = [];
  total(): number {
    return 0;
  }
  #secret(): void {}
}

class Hidden {}
