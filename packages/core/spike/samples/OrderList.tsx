import React, { useState } from 'react';
import type { Order } from './orders';

interface Props {
  orders: Order[];
  onSelect?: (id: string) => void;
}

export function OrderList({ orders, onSelect }: Props) {
  const [selected, setSelected] = useState<string>();
  return (
    <ul>
      {orders.map((o) => (
        <li key={o.id} onClick={() => { setSelected(o.id); onSelect?.(o.id); }}>{o.id}</li>
      ))}
    </ul>
  );
}

export const EmptyState = () => <p>No orders</p>;
