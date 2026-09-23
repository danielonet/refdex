import { readFile } from 'node:fs/promises';
import type { Customer } from '@app/customers';
export { formatMoney } from './money';

export interface Order {
  id: string;
  total: number;
  lines(): OrderLine[];
}

export type OrderLine = { sku: string; qty: number };

export enum OrderStatus {
  Open,
  Shipped,
}

export abstract class Repository<T> {
  protected cache = new Map<string, T>();
  abstract find(id: string): Promise<T | undefined>;
}

export class OrderService extends Repository<Order> implements Disposable {
  constructor(private readonly customer: Customer) {
    super();
  }

  async find(id: string): Promise<Order | undefined> {
    return this.cache.get(id);
  }

  [Symbol.dispose](): void {}
}

export function totalOf(orders: Order[]): number {
  return orders.reduce((sum, o) => sum + o.total, 0);
}

export const loadOrders = async (path: string): Promise<Order[]> => JSON.parse(await readFile(path, 'utf8'));

const isOpen = function (o: Order) {
  return o.total > 0;
};
