import * as fs from 'node:fs';
import React from 'react';
import { type Order, OrderModel } from '@app/models/order';
import { Client, OrderModel as Model } from '@models';
import { helper } from '../util.js';
import { libFn } from '@fx/lib';
import './side-effect-missing';

export class OrderService {
  constructor(private readonly client: Client) {}

  find(id: string): Order | undefined {
    return new OrderModel();
  }
}
