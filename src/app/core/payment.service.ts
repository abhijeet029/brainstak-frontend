import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { environment } from '../../environments/environment';

export interface CreatePaymentOrderResponse {
  merchantOrderId: string;
  plan: 'pro';
  amount: number;
  currency: 'INR';
  paymentUrl: string;
  provider: 'phonepe';
}

@Injectable({ providedIn: 'root' })
export class PaymentService {
  private http = inject(HttpClient);
  private base = environment.apiUrl + '/v1';

  createOrder(plan: 'pro') {
    return this.http.post<CreatePaymentOrderResponse>(`${this.base}/payments/create-order`, { plan });
  }
}
