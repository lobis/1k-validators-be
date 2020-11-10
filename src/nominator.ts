import { SubmittableExtrinsic } from "@polkadot/api/types";
import Keyring from "@polkadot/keyring";
import { KeyringPair } from "@polkadot/keyring/types";
import ApiHandler from "./ApiHandler";

import Database from "./db";
import logger from "./logger";

import { NominatorConfig, Stash } from "./types";

export default class Nominator {
  public currentlyNominating: Stash[] = [];
  public maxNominations: number;

  private _controller: string;
  private db: Database;
  private handler: ApiHandler;
  private signer: KeyringPair;

  // Use proxy of controller instead of controller directly.
  private _isProxy: boolean;

  constructor(
    handler: ApiHandler,
    db: Database,
    cfg: NominatorConfig,
    networkPrefix = 2
  ) {
    this.handler = handler;
    this.db = db;
    this.maxNominations = cfg.maxNominations;
    this._isProxy = cfg.isProxy || false;

    const keyring = new Keyring({
      type: "sr25519",
    });

    keyring.setSS58Format(networkPrefix);

    this.signer = keyring.createFromUri(cfg.seed);
    this._controller = this._isProxy ? cfg.proxyFor : this.signer.address;
    logger.info(
      `(Nominator::constructor) Nominator signer spawned: ${this.address}`
    );
  }

  public get address(): string {
    if (this._isProxy) {
      return this.signer.address;
    }

    return this.controller;
  }

  public get controller(): string {
    return this._controller;
  }

  public async stash(): Promise<any> {
    const api = await this.handler.getApi();
    const ledger = await api.query.staking.ledger(this.controller);
    const { stash } = ledger.unwrap();

    return stash;
  }

  public async nominate(targets: Stash[], dryRun = false): Promise<boolean> {
    const now = new Date().getTime();

    if (dryRun) {
      logger.info(`DRY RUN - STUBBING TRANSACTIONS`);
      for (const stash of targets) {
        await this.db.setTarget(this.controller, stash, now);
        await this.db.setLastNomination(this.controller, now);
      }
    } else {
      const api = await this.handler.getApi();

      let tx: SubmittableExtrinsic<"promise">;
      if (this._isProxy) {
        const innerTx = api.tx.staking.nominate(targets);
        tx = api.tx.proxy.proxy(this.controller, "None", innerTx);
      } else {
        logger.info(
          `(Nominator::nominate) Creating extrinsic Staking::nominate from ${this.address} to targets ${targets} at ${now}`
        );
        tx = api.tx.staking.nominate(targets);
      }

      logger.info("(Nominator::nominate} Sending extrinsic to network...");
      const unsub = await tx.signAndSend(this.signer, async (result: any) => {
        const { status } = result;

        logger.info(`(Nominator::nominate) Status now: ${status.type}`);
        if (status.isFinalized) {
          logger.info(
            `(Nominator::nominate) Included in block ${status.asFinalized}`
          );
          this.currentlyNominating = targets;
          for (const stash of targets) {
            await this.db.setTarget(this.controller, stash, now);
            await this.db.setLastNomination(this.controller, now);
          }
          unsub();
        }
      });
    }

    return true;
  }
}
