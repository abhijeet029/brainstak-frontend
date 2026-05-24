import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { UsageService } from '../../core/usage.service';
import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'app-usage-modal',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './usage-modal.component.html',
  styleUrl: './usage-modal.component.scss',
})
export class UsageModalComponent {
  private usage = inject(UsageService);
  private auth = inject(AuthService);

  today = this.usage.today;
  week = this.usage.week;
  tier = () => this.auth.user()?.tier ?? 'free';
  planName = () => {
    const tier = this.tier();
    if (tier === 'team') return 'Team';
    if (tier === 'pro') return 'Pro';
    return 'Free';
  };
  planSummary = () => {
    const tier = this.tier();
    if (tier === 'team') return 'Best for deeper reasoning with Low, Medium, and High intelligence.';
    if (tier === 'pro') return 'Balanced plan with Low and Medium intelligence.';
    return 'Entry plan with Low intelligence and daily token protection.';
  };
  availableIntelligence = () => {
    const levels = this.today()?.plan?.availableIntelligence;
    if (levels?.length) {
      return levels.map((level) => level[0]!.toUpperCase() + level.slice(1)).join(', ');
    }
    const tier = this.tier();
    if (tier === 'team') return 'Low, Medium, High';
    if (tier === 'pro') return 'Low, Medium';
    return 'Low';
  };
  ragAvailable() {
    return true;
  }
  ragAvailabilityLabel() {
    return this.ragAvailable() ? 'Included' : 'Upgrade required';
  }
  ragPlans() {
    const current = this.tier();
    return [
      { name: 'Free', value: 'free', enabled: true, current: current === 'free' },
      { name: 'Pro', value: 'pro', enabled: true, current: current === 'pro' },
      { name: 'Team', value: 'team', enabled: true, current: current === 'team' },
    ];
  }
  usedToday() {
    return this.today()?.tokens ?? 0;
  }
  remainingToday() {
    return this.today()?.remaining ?? 0;
  }
  dailyCap() {
    return this.today()?.cap ?? this.auth.user()?.dailyTokenCap ?? 0;
  }
  mediumBufferRemaining() {
    return this.today()?.intelligence?.mediumRemainingBeforeDowngrade ?? null;
  }
  highBufferRemaining() {
    return this.today()?.intelligence?.highRemainingBeforeDowngrade ?? null;
  }
  mediumFallsBackAt() {
    return this.today()?.intelligence?.mediumFallsBackAt ?? null;
  }
  highFallsBackAt() {
    return this.today()?.intelligence?.highFallsBackAt ?? null;
  }
  mediumFallbackTarget() {
    return this.today()?.intelligence?.mediumDowngradesTo ?? null;
  }
  highFallbackTarget() {
    return this.today()?.intelligence?.highDowngradesTo ?? null;
  }

  resetsIn() {
    const iso = this.today()?.resetsAt;
    if (!iso) return '';
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return 'soon';
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return `in ${h}h ${m}m`;
  }
}
