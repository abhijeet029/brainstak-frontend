import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { tap } from 'rxjs';
import { environment } from '../../environments/environment';
import { ModelPriorityGroup, ModelPriorityTier, User } from './models';
import { AuthService } from './auth.service';

@Injectable({ providedIn: 'root' })
export class UserService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private base = environment.apiUrl + '/v1';

  updateProfile(body: { name?: string; phone?: string }) {
    return this.http
      .put<{ user: User }>(`${this.base}/users/me`, body)
      .pipe(tap((res) => this.auth.setUser(res.user)));
  }

  getModelPriorities() {
    return this.http.get<{ tiers: ModelPriorityGroup[] }>(`${this.base}/users/me/model-priorities`);
  }

  updateModelPriority(tier: ModelPriorityTier, modelOrder: string[]) {
    return this.http.put<Pick<ModelPriorityGroup, 'tier' | 'modelOrder' | 'custom'>>(
      `${this.base}/users/me/model-priorities`,
      { tier, modelOrder },
    );
  }

  resetModelPriority(tier: ModelPriorityTier) {
    return this.http.delete<Pick<ModelPriorityGroup, 'tier' | 'modelOrder' | 'custom'>>(
      `${this.base}/users/me/model-priorities/${tier}`,
    );
  }
}
