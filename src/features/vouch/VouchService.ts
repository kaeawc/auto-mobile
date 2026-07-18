/**
 * Application service wiring the pure {@link VouchEngine} to persistence.
 *
 * Each mutating call loads the current trust graph, applies one engine operation,
 * and persists the result. The graph is a repo's contributor set (small), so
 * load-apply-save per call is simple and correct; there is no long-lived in-memory
 * cache to invalidate across daemon restarts or GitHub Action invocations.
 */

import { VouchRepository } from "../../db/vouchRepository";
import { VouchEngine, type DenounceResult, type VouchEngineOptions } from "./VouchEngine";
import type { GateDecision, InviteToken, Member } from "./types";

export interface VouchServiceOptions extends VouchEngineOptions {
  repository?: VouchRepository;
  engine?: VouchEngine;
}

export class VouchService {
  private readonly repository: VouchRepository;
  private readonly engine: VouchEngine;

  constructor(options: VouchServiceOptions = {}) {
    this.repository = options.repository ?? new VouchRepository();
    this.engine =
      options.engine ??
      new VouchEngine({
        idGenerator: options.idGenerator,
        timer: options.timer,
        policy: options.policy,
      });
  }

  /** Bootstrap a seed member (repo owner as `founder`, trusted devs as `contributor`). */
  async seedMember(login: string, role: "founder" | "contributor"): Promise<Member> {
    const state = await this.repository.loadState();
    const member = this.engine.seedMember(state, login, role);
    await this.repository.saveMember(member);
    return member;
  }

  /** Issue a single-use invite token on behalf of an active member with budget. */
  async issueInvite(issuerLogin: string): Promise<InviteToken> {
    const state = await this.repository.loadState();
    const invite = this.engine.issueInvite(state, issuerLogin);
    // Persist the full state so any invites that expired during the reap are saved too.
    await this.repository.saveState(state);
    return invite;
  }

  /** Redeem a pending invite, admitting the redeemer as a `vouched` member. */
  async redeemInvite(token: string, redeemerLogin: string): Promise<Member> {
    const state = await this.repository.loadState();
    const member = this.engine.redeemInvite(state, token, redeemerLogin);
    await this.repository.saveState(state);
    return member;
  }

  /**
   * Directly admit a newcomer on behalf of an issuer — the common gate flow where
   * an existing member vouches someone in without a token round-trip. Equivalent
   * to issuing an invite and immediately redeeming it, spending one vouch slot.
   */
  async admit(issuerLogin: string, newcomerLogin: string): Promise<Member> {
    const state = await this.repository.loadState();
    const invite = this.engine.issueInvite(state, issuerLogin);
    const member = this.engine.redeemInvite(state, invite.token, newcomerLogin);
    await this.repository.saveState(state);
    return member;
  }

  /** Denounce a member: revoke their sub-tree and penalise their voucher chain. */
  async denounce(login: string, reason: string): Promise<DenounceResult> {
    const state = await this.repository.loadState();
    const result = this.engine.denounce(state, login, reason);
    await this.repository.saveState(state);
    return result;
  }

  /**
   * Decide whether an actor's issue/PR passes the gate. Read-only and
   * fail-safe-closed: if the graph cannot be loaded, an unknown actor is returned
   * (denied) rather than throwing at the call site.
   */
  async evaluateGate(login: string): Promise<GateDecision> {
    const state = await this.repository.loadStateOrEmpty();
    return this.engine.evaluateGate(state, login);
  }

  /** Remaining invite budget for a member. */
  async remainingCapacity(login: string): Promise<number> {
    const state = await this.repository.loadState();
    return this.engine.remainingCapacity(state, login);
  }
}
