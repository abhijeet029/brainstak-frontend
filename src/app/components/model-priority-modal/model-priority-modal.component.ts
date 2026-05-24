import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { AuthService } from '../../core/auth.service';
import { ModelPriorityGroup, ModelPriorityTier } from '../../core/models';
import { ToastService } from '../../core/toast.service';
import { UserService } from '../../core/user.service';

type PlanTier = 'free' | 'pro' | 'team';

@Component({
  selector: 'app-model-priority-modal',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './model-priority-modal.component.html',
  styleUrl: './model-priority-modal.component.scss',
})
export class ModelPriorityModalComponent implements OnInit, OnDestroy {
  private auth = inject(AuthService);
  private userSvc = inject(UserService);
  private toast = inject(ToastService);
  private modalOpenHandler = (e: Event) => {
    if ((e.target as HTMLElement).id === 'modelPriorityModal') this.loadModelPriorities();
  };

  readonly loading = signal(false);
  readonly saving = signal<ModelPriorityTier | null>(null);
  readonly error = signal<string | null>(null);
  readonly modelPriorities = signal<ModelPriorityGroup[]>([]);
  readonly dragging = signal<{ tier: ModelPriorityTier; index: number } | null>(null);

  readonly planTier = computed<PlanTier>(() => normalizePlan(this.auth.user()?.tier));
  readonly planName = computed(() => titleCase(this.planTier()));
  readonly allowedTiers = computed<ModelPriorityTier[]>(() => {
    switch (this.planTier()) {
      case 'team':
        return ['cheap', 'mid', 'premium'];
      case 'pro':
        return ['cheap', 'mid'];
      default:
        return ['cheap'];
    }
  });
  readonly visiblePriorities = computed(() => {
    const allowed = new Set(this.allowedTiers());
    return this.modelPriorities().filter((group) => allowed.has(group.tier));
  });
  readonly hiddenLevelText = computed(() => {
    const hidden = this.modelPriorities()
      .filter((group) => !this.allowedTiers().includes(group.tier))
      .map((group) => group.label);
    return hidden.length ? hidden.join(', ') : null;
  });

  ngOnInit() {
    this.loadModelPriorities();
    document.addEventListener('show.bs.modal', this.modalOpenHandler);
  }

  ngOnDestroy() {
    document.removeEventListener('show.bs.modal', this.modalOpenHandler);
  }

  onDragStart(event: DragEvent, tier: ModelPriorityTier, index: number) {
    this.dragging.set({ tier, index });
    event.dataTransfer?.setData('text/plain', `${tier}:${index}`);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  onDragOver(event: DragEvent) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }

  onDrop(event: DragEvent, tier: ModelPriorityTier, targetIndex: number) {
    event.preventDefault();
    const dragged = this.dragging();
    if (!dragged || dragged.tier !== tier || dragged.index === targetIndex) {
      this.dragging.set(null);
      return;
    }
    this.reorder(tier, dragged.index, targetIndex);
    this.dragging.set(null);
  }

  onDragEnd() {
    this.dragging.set(null);
  }

  isDragging(tier: ModelPriorityTier, index: number) {
    const dragging = this.dragging();
    return dragging?.tier === tier && dragging.index === index;
  }

  moveModel(tier: ModelPriorityTier, index: number, direction: -1 | 1) {
    this.reorder(tier, index, index + direction);
  }

  saveModelPriority(tier: ModelPriorityTier) {
    const group = this.modelPriorities().find((item) => item.tier === tier);
    if (!group || this.saving()) return;
    this.saving.set(tier);
    this.error.set(null);

    this.userSvc.updateModelPriority(tier, group.modelOrder.map((model) => model.id)).subscribe({
      next: (res) => {
        this.modelPriorities.update((groups) => groups.map((item) =>
          item.tier === tier ? { ...item, modelOrder: res.modelOrder, custom: res.custom } : item
        ));
        this.saving.set(null);
        this.toast.show(`${group.label} priority saved.`, 'success');
      },
      error: (e) => {
        const message = e?.error?.message ?? e?.error?.error ?? 'Could not save model priority';
        this.saving.set(null);
        this.error.set(message);
        this.toast.show(message, 'error');
      },
    });
  }

  resetModelPriority(tier: ModelPriorityTier) {
    const group = this.modelPriorities().find((item) => item.tier === tier);
    if (!group || this.saving()) return;
    this.saving.set(tier);
    this.error.set(null);

    this.userSvc.resetModelPriority(tier).subscribe({
      next: (res) => {
        this.modelPriorities.update((groups) => groups.map((item) =>
          item.tier === tier ? { ...item, modelOrder: res.modelOrder, custom: res.custom } : item
        ));
        this.saving.set(null);
        this.toast.show(`${group.label} priority reset to owner default.`, 'success');
      },
      error: (e) => {
        const message = e?.error?.message ?? e?.error?.error ?? 'Could not reset model priority';
        this.saving.set(null);
        this.error.set(message);
        this.toast.show(message, 'error');
      },
    });
  }

  private reorder(tier: ModelPriorityTier, fromIndex: number, toIndex: number) {
    this.modelPriorities.update((groups) => groups.map((group) => {
      if (group.tier !== tier || toIndex < 0 || toIndex >= group.modelOrder.length) return group;
      const modelOrder = [...group.modelOrder];
      const [item] = modelOrder.splice(fromIndex, 1);
      if (!item) return group;
      modelOrder.splice(toIndex, 0, item);
      return { ...group, modelOrder, custom: true };
    }));
  }

  private loadModelPriorities() {
    this.loading.set(true);
    this.error.set(null);
    this.userSvc.getModelPriorities().subscribe({
      next: (res) => {
        this.modelPriorities.set(res.tiers);
        this.loading.set(false);
      },
      error: (e) => {
        const message = e?.error?.message ?? e?.error?.error ?? 'Could not load model priorities';
        this.error.set(message);
        this.loading.set(false);
      },
    });
  }
}

function normalizePlan(tier: string | undefined): PlanTier {
  return tier === 'team' || tier === 'pro' ? tier : 'free';
}

function titleCase(tier: PlanTier): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}
