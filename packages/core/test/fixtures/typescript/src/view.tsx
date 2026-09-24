import { OrderService } from './services/orderService';

export function OrderView({ service }: { service: OrderService }) {
  return <div>{String(service)}</div>;
}
