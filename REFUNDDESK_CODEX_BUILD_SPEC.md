# RefundDesk — cahier des charges v1.1

> Version : 1.1
> Date de décision : 25 juillet 2026
> Statut : phase 0 `PASS` — 34/34 cas Stripe réels `passed_real`
> Livraison : pilote test/sandbox uniquement ; phase 1 complète localement
> Langue produit : anglais
> Langue de référence : français, identifiants techniques en anglais

Ce document est la source de vérité produit et technique de RefundDesk. La version 1.0 reste disponible dans l’historique Git. Les décisions marquées « verrouillées » ne peuvent être changées qu’au moyen d’un ADR.

Le verdict de phase 0 confirme la faisabilité du pilote dans les environnements autorisés. Il ne
constitue ni une approbation Stripe Marketplace, ni une autorisation live, ni une validation de
production. La provenance exacte de la version Stripe App téléversée est consignée dans
`PLANS.md` et dans le rapport de preuve local expurgé.

## 1. Mission et promesse

RefundDesk ajoute un workflow à deux personnes aux remboursements Stripe :

1. un utilisateur demande un remboursement depuis la fiche d’un paiement ;
2. un approbateur distinct accepte ou refuse la demande ;
3. le backend RefundDesk crée au plus un remboursement Stripe pour cette demande ;
4. les décisions, tentatives et rapprochements restent auditables pendant la durée de rétention ;
5. les remboursements détectés hors de ce workflow sont signalés.

Promesse publique autorisée :

> **Require approval for refunds initiated through RefundDesk, record every workflow decision, and flag refunds detected outside it.**

RefundDesk ne promet pas de bloquer les remboursements effectués directement dans Stripe, par une autre clé API ou par une autre intégration. L’audit est garanti uniquement pendant la durée de rétention configurée.

### 1.1 Tranche verticale du pilote

Le pilote couvre uniquement :

- des paiements carte synthétiques en mode test ou managed sandbox ;
- une demande partielle ou totale ;
- un approbateur explicitement autorisé et distinct du demandeur ;
- la création d’un unique objet `Refund` Stripe ;
- l’audit et l’export ;
- la détection et la qualification d’un remboursement extérieur.

### 1.2 Hors périmètre

Sont différés :

- mode live et déploiement de production ;
- publication Stripe App Marketplace ;
- Stripe Connect et remboursements de comptes connectés ;
- paiements autres que carte et Terminal `card_present` ;
- disputes, credit notes et remboursements par ligne de facture ;
- politiques Team, quorum supérieur à un et seuils multi-devises ;
- Billing, essai, quotas, abonnements et facturation RefundDesk ;
- e-mails et intégrations Slack, Teams, Zendesk ou équivalentes ;
- pages marketing ou SEO ;
- pièces jointes, documents et données client finales ;
- comptes RefundDesk autonomes, mot de passe et SSO ;
- application mobile ;
- décision automatique ou IA.

Les interfaces `AccessPolicy` et `NotificationProvider` sont conservées. Leur implémentation pilote autorise uniquement test/sandbox et n’envoie aucune notification.

## 2. Autorisation du premier cycle

Le premier cycle autorise :

- le dépôt Git local ;
- l’installation de dépendances locales ;
- PostgreSQL et les services locaux ;
- une Stripe App non publiée ;
- les appels Stripe test/sandbox nécessaires au spike et aux tests ;
- la création de petits paiements synthétiques.

Il interdit sans nouvelle autorisation explicite :

- toute clé, ressource ou requête live ;
- tout remboursement sur une donnée client réelle ;
- tout déploiement Render ou autre service externe ;
- toute ressource payante ;
- tout push vers un dépôt distant ;
- toute publication Marketplace.

Les secrets sont saisis localement dans un fichier ignoré par Git ou un gestionnaire de secrets. Ils ne sont ni collés dans un ticket ou une conversation, ni journalisés, ni inclus dans un rapport.

## 3. Décisions techniques verrouillées

| Domaine        | Décision                                                                 |
| -------------- | ------------------------------------------------------------------------ |
| Runtime        | Node.js `24.18.0`                                                        |
| Gestionnaire   | pnpm `11.17.0` et workspaces                                             |
| Langage        | TypeScript strict                                                        |
| Web/API        | Next.js `16.2.11`, App Router, runtime Node                              |
| Base           | PostgreSQL 18                                                            |
| ORM            | Prisma `7.9.0` avec `@prisma/adapter-pg`                                 |
| Jobs           | pg-boss `12.26.3`, processus worker séparé                               |
| Stripe serveur | `stripe` Node `22.3.2`                                                   |
| Stripe UI      | `@stripe/ui-extension-sdk` `9.1.0`                                       |
| API Stripe     | `2026-06-24.dahlia`                                                      |
| Validation     | Zod aux frontières HTTP, environnement et jobs                           |
| Logs           | JSON structurés avec redaction stricte                                   |
| Tests          | Vitest, Testing Library, Testcontainers PostgreSQL et Stripe CLI/sandbox |
| Monnaie        | chaîne décimale aux frontières, `bigint` dans le domaine et en base      |

Les versions exactes restent verrouillées dans le lockfile. Toute incompatibilité démontrée doit être consignée dans un ADR avant changement.

### 3.1 Topologie

Le monorepo sépare :

- la Stripe App et ses viewports ;
- l’API web ;
- le worker pg-boss ;
- le domaine pur ;
- les contrats signés ;
- l’accès PostgreSQL ;
- l’adaptateur Stripe ;
- l’observabilité ;
- les notifications.

Le web et le worker utilisent des rôles PostgreSQL sans `BYPASSRLS`. Les migrations Prisma et pg-boss sont exécutées par un rôle propriétaire distinct, une seule fois par version.

Le rôle web peut enregistrer une demande et une décision signée, mais ne peut ni écrire une
exécution, une tentative ou un candidat de corrélation, ni déplacer une demande vers `executing` ou
`succeeded`. PostgreSQL exige une décision durable d’un approbateur actif, distinct du demandeur,
et un quorum cohérent avant `approved` ou `rejected`. Le rôle worker possède seul les écritures de
frontière d’effet. L’unique exception web est une transition de désautorisation monotone qui rend
une demande moins exécutable après suspension durable de l’installation.

## 4. Phase 0 — spike réel et bloquant

La phase 0 prouve les hypothèses qui conditionnent le cœur financier. Un mock ou un test unitaire ne peut produire un verdict `PASS`.

### 4.1 Surface de probe

Le spike crée :

- une vue Stripe `stripe.dashboard.payment.detail` ;
- un endpoint signé réservé au probe ;
- un endpoint signé Administrator retournant l’état de corrélation expurgé ;
- une allowlist de PaymentIntent synthétiques ;
- un refus systématique de `livemode=true` ;
- un rapport expurgé JSON et Markdown.

Les endpoints directs de probe et de rapport sont désactivés puis supprimés avant le pilote.

Le store de corrélation propre au spike est volontairement mono-processus et non durable : le serveur
ne doit pas être redémarré entre le premier appel, son rejeu et l’observation du webhook. Un redémarrage
rend le cas concerné inconclusif et impose une nouvelle fixture et un nouveau nonce. Cette exception ne
s’applique pas au pilote, dont les receipts, liens, guards et preuves sont persistés dans PostgreSQL.

### 4.2 Enveloppe signée

L’enveloppe canonique contient un préfixe commun, dans cet ordre :

1. `operation`
2. `request_nonce`
3. `mode`
4. `is_sandbox`
5. `resource_type`

Pour `payment_intent` ou `charge`, `resource_id` suit immédiatement `resource_type`. Pour une
opération de compte, `resource_id` est interdit : le scope repose sur le seul `account_id` ajouté et
signé par Stripe, puis lié à l’installation côté serveur.

Les champs suivants sont ensuite sérialisés :

1. `command_json`
2. `roles_asserted`
3. `stripe_roles` uniquement si `roles_asserted=true`
4. `user_id`
5. `account_id`

`roles_asserted=false` interdit et omet `stripe_roles`. Cette forme authentifie l’identité Stripe, le
compte, l’environnement, la ressource éventuelle et la commande, mais ne constitue aucune preuve de
rôle. Elle suffit aux opérations ordinaires dont l’autorisation ne dépend pas d’un rôle Stripe.
`roles_asserted=true` exige une liste non vide de rôles Stripe strictement validés. Toute opération
Administrateur et tout provisioning exigent cette seconde forme.
Une requête sans assertion de rôle ne peut jamais effacer ou remplacer la dernière observation
durable de rôles.

Le client produit la signature Stripe avec les données additionnelles. Le serveur :

- reçoit les octets bruts ;
- refuse tout champ supplémentaire ;
- vérifie la signature avant le parsing métier ;
- vérifie l’ordre et le nom des champs ;
- impose un âge maximal court ;
- compare `user_id` et `account_id` signés au contexte demandé ;
- valide le discriminant de rôle, les rôles éventuels et le payload avec Zod strict ;
- lie compte, mode, sandbox et credential serveur.

Une sérialisation reconstruite ne remplace jamais les octets effectivement signés.

### 4.3 Matrice de preuves

| Gate             | Preuve réelle attendue                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `APP`            | App créée et installée sans publication                                                                             |
| `UI`             | Vue payment detail rendue sur le paiement synthétique                                                               |
| `SIGNATURE`      | Requête valide acceptée ; ordre, corps ou compte altérés refusés                                                    |
| `ROLE_GAP`       | Un utilisateur `View only` voit le paiement, ne peut pas le rembourser nativement et peut demander le remboursement |
| `REFUND`         | Le backend crée le Refund grâce aux permissions de l’app                                                            |
| `IDEMPOTENCY`    | Le rejeu de la même clé retourne le même `re_...`                                                                   |
| `WEBHOOK`        | `refund.created` est reçu, vérifié et dédupliqué                                                                    |
| `EXTERNAL`       | Un remboursement manuel est classé externe                                                                          |
| `PROOF_REPLAY`   | Un second Refund recopiant les metadata est signalé sans remplacer le premier ID lié                                |
| `ENV`            | Test mode et managed sandbox sont prouvés séparément ; les croisements sont refusés                                 |
| `PERMISSIONS`    | Seules les permissions minimales requises sont présentes                                                            |
| `PUBLISHABILITY` | Aucun obstacle de distribution connu n’invalide le pilote                                                           |

Utilisateurs nécessaires :

- un Administrator ;
- un utilisateur Stripe `View only` capable de voir les paiements mais pas de les rembourser nativement.

Permissions minimales confirmées par la phase 0 :

- `charge_read`
- `charge_write`
- `payment_intent_read`
- `event_read`

Ne pas demander `user_email_read`.

### 4.4 Verdict

- `PASS` : chaque gate est `passed_real`.
- `BLOCKED_HUMAN` : login, MFA, secret, installation, permission ou second utilisateur manque. Le scaffold non financier peut continuer, mais aucune phase financière ne peut être déclarée validée.
- `FAIL` : une impossibilité technique ou de publication est prouvée par un essai réel. Le cœur financier s’arrête et l’alternative minimale est documentée.

Le rapport ne contient aucun secret, payload complet, e-mail, justification ou donnée client réelle.

## 5. Identité, installation et autorisation

Stripe authentifie l’utilisateur Dashboard. RefundDesk n’a pas de compte utilisateur séparé.

Une installation est identifiée par le triplet :

```text
stripe_account_id + mode + is_sandbox
```

Une requête ne peut accéder qu’au tenant correspondant à ce triplet. Les credentials test et managed sandbox sont différents. Le chemin live reste fermé par deux interrupteurs indépendants :

```text
global_live_enabled = false
tenant_live_enabled = false
```

Le pilote refuse l’opération si l’un des deux n’est pas explicitement vrai ; le premier cycle ne fournit aucune procédure pour les activer.

### 5.1 Approbateurs

- l’Administrator courant peut s’activer comme premier approbateur ;
- les autres approbateurs sont autorisés explicitement parmi les utilisateurs Stripe observés ;
- le rôle Stripe Administrator n’accorde pas automatiquement le rôle RefundDesk approver ;
- le demandeur ne peut jamais décider sa propre demande ;
- une demande est refusée à la création si aucun approbateur distinct éligible n’existe.

Le pilote utilise un quorum fixe de un.

## 6. Éligibilité d’un paiement

Le paiement est éligible seulement si toutes les conditions suivantes sont vraies au moment de la création puis à nouveau juste avant l’effet :

- le compte, le mode et le marqueur sandbox correspondent à l’installation ;
- le PaymentIntent a une Charge capturée ;
- `Charge.payment_method_details.type === "card"` ;
- la carte n’est pas `card_present` ;
- le paiement n’appartient pas à un flux Connect ;
- aucune dispute ne rend l’opération inéligible ;
- la devise est connue ;
- `0 < requested_amount <= refundable_amount`.

Les wallets rapportés par Stripe comme carte suivent la branche carte. Toute autre méthode est refusée.

### 6.1 Montants et motifs

- les API transportent `amount_minor` comme chaîne de chiffres ASCII ;
- le domaine et PostgreSQL utilisent un entier exact ;
- aucun nombre JavaScript flottant ne représente un montant ;
- la devise est en minuscules et provient de Stripe ;
- les motifs Stripe autorisés sont `duplicate`, `fraudulent`, `requested_by_customer` ;
- la justification contient de 10 à 2 000 caractères après normalisation.

## 7. Cycle de vie

États métier principaux :

```text
pending_approval
  ├─ approved -> executing
  │                ├─ succeeded
  │                │    └─ failed_terminal
  │                │       (même Refund lié, ensuite confirmé failed)
  │                ├─ failed_terminal
  │                └─ reconciliation_required
  │                     ├─ executing
  │                     │  (absence prouvée, même exécution et même clé)
  │                     ├─ succeeded
  │                     └─ failed_terminal
  ├─ rejected
  ├─ canceled
  ├─ expired
  └─ stale
```

Règles :

- expiration après sept jours ;
- rejet avec motif obligatoire ;
- annulation par le demandeur uniquement avant approbation ;
- transition par comparaison-et-échange atomique ;
- une seule décision gagnante ;
- un seul job d’exécution actif ;
- aucune transaction PostgreSQL ouverte pendant un appel réseau Stripe.

### 7.1 Frontière d’effet

`effect_state` distingue :

- `not_started` : aucun appel Stripe n’a franchi la frontière ;
- `possible` : l’effet a pu avoir lieu, mais aucun Refund n’est encore identifié ;
- `identified` : le premier Refund ID est lié ;
- `absence_proven` : Stripe a permis de prouver l’absence d’effet.

Le guard d’unicité :

- est libéré après rejet, annulation ou expiration ;
- n’est libéré après `failed_terminal` ou `stale` que si `effect_state=absence_proven` ;
- n’est jamais libéré en `reconciliation_required` ;
- reste détenu pour un Refund `pending` ou `requires_action` jusqu’à `succeeded`, `failed` ou `canceled`.

## 8. Exécution Stripe

Le worker :

1. revendique le job de manière atomique ;
2. recharge la demande et l’installation ;
3. revalide l’éligibilité et le montant restant ;
4. persiste l’intention d’appel et la clé idempotente ;
5. termine la transaction ;
6. appelle `refunds.create` avec le compte et le credential explicites ;
7. persiste la réponse ou passe en réconciliation ;
8. n’utilise jamais une seconde clé pour contourner une réponse ambiguë.

La récupération durable réenfile `approved/not_started` et `executing/not_started`. Elle réenfile
`executing/absence_proven` uniquement si l’exécution persistée porte la clé déterministe attendue
et ne contient aucun Refund lié. `executing/possible`, une identité d’exécution absente ou
incohérente, une autre clé ou un Refund déjà lié imposent `reconciliation_required`. Aucune
récupération ne génère une nouvelle exécution ou une nouvelle clé.

Clé idempotente déterministe :

```text
refunddesk:refund-request:<request_uuid>:v1
```

Les metadata ne contiennent qu’un identifiant opaque et une preuve HMAC versionnée. Aucune justification, aucun e-mail et aucune donnée client ne sont envoyés en metadata.

### 8.1 Liaison d’un Refund

Le premier Refund ID est lié par ordre de confiance :

1. réponse Stripe de `refunds.create` ;
2. idempotency key correspondante lorsqu’elle est exposée par l’Event ;
3. candidat unique dont la preuve HMAC est valide et dont compte, environnement, PaymentIntent/Charge, montant et devise correspondent.

L’idempotency key d’un Event est une preuve secondaire et nullable.

Après liaison :

- le Refund ID est immuable ;
- une observation Stripe autoritative de ce même Refund — Event vérifié ordonné par
  `Event.created`, ou snapshot courant obtenu par récupération directe de l’ID immuable — peut
  corriger `succeeded` en `failed_terminal`, avec `identified -> absence_proven`, sans réécrire les
  timestamps terminaux ou de libération du guard ;
- à timestamp Stripe égal, `failed` prévaut et un état `failed` ne régresse jamais ;
- un autre Refund ID avec la même preuve est `proof_replay` ou `tampering` ;
- il ne remplace jamais le premier ID ;
- une ambiguïté mène à `reconciliation_required`, pas à un nouvel appel.

## 9. Webhooks, remboursements externes et scans

Les endpoints connected sont séparés pour :

- test ;
- managed sandbox ;
- live, présent mais désactivé pour le premier cycle.

Chaque endpoint :

- vérifie la signature sur le corps brut ;
- refuse un compte ou environnement inattendu ;
- déduplique l’Event par identifiant ;
- persiste un receipt minimal ;
- acquitte rapidement puis délègue le traitement.

Le système traite au minimum les événements Refund nécessaires à la création et aux changements d’état.

### 9.1 Classification

Un Refund connu est celui lié à une demande par une preuve suffisante. Un Refund sans preuve de workflow est externe.

Si un Refund externe apparaît :

- pendant `pending_approval` ou `approved`, la demande devient `stale` et le job est neutralisé par CAS ;
- pendant `executing` ou `reconciliation_required`, l’état reste protégé et une réconciliation est imposée ;
- après une terminaison interne, son heure Stripe est comparée à la fenêtre d’exécution inclusive ;
- une alerte externe non réconciliée protège durablement le tenant, l’installation, l’environnement
  et le paiement, même si le guard de la demande a déjà été libéré ;
- l’acquittement d’une alerte ne constitue jamais une réconciliation et ne retire pas cette protection ;
- aucun chemin ne rappelle automatiquement `refunds.create`.

### 9.2 Scanner

Le scanner s’exécute toutes les quinze minutes, par tenant et environnement :

- un passage paginé liste les Refunds créés dans une fenêtre temporelle avec un chevauchement
  d’une heure ;
- un passage distinct page les workflows portant un Refund lié et récupère chacun directement par
  son ID, même si sa création est antérieure à la fenêtre ;
- première fenêtre ancrée à l’heure d’installation, et non à l’heure de démarrage tardive du worker ;
- checkpoint temporel avancé seulement après traitement réussi de toutes les pages temporelles ;
- reprise depuis l’ancien checkpoint après échec ;
- une transition vers `reconciliation_required` reçoit une borne
  `reconciliation_safe_after_at` gérée par PostgreSQL ;
- une fenêtre complète ne prouve l’absence que si elle commence au plus tard à
  `execution_started_at`, se termine au plus tôt à `reconciliation_safe_after_at`, ne trouve aucun
  candidat et ne rencontre aucune alerte externe non réconciliée ;
- la preuve d’absence reprend l’exécution existante avec sa clé originale ; une fenêtre partielle
  ne modifie pas l’ambiguïté ;
- l’échec d’un rafraîchissement lié n’affame ni les cibles suivantes ni le passage temporel, mais
  l’échec agrégé conserve le retry ;
- erreur isolée par installation afin qu’un tenant défaillant n’affame pas les suivants, puis
  échec agrégé du job pour conserver le retry ;
- déduplication par Refund ID.

Un webhook perdu doit être retrouvé en moins de trente minutes dans les conditions normales du pilote.

## 10. API interne

Routes signées :

- `context/sync`
- `payments/eligibility`
- `refund-requests/create`
- `refund-requests/list`
- `refund-requests/get`
- `refund-requests/decide`
- `refund-requests/cancel`
- `external-alerts/list`
- `external-alerts/acknowledge`
- `settings/get`
- `settings/update`
- `audit/export`

Routes système :

- webhooks connected `test`, `sandbox`, `live` ;
- `health` pour la vie du processus ;
- `ready` pour les dépendances indispensables.

Il n’existe ni route Billing, ni proxy Stripe générique.

### 10.1 Idempotence des mutations

Une mutation signée utilise `request_nonce`.

- même nonce, même acteur, même opération et même hash canonique : réponse persistée identique ;
- même nonce avec acteur, opération ou payload différent : `409 IDEMPOTENCY_CONFLICT` ;
- les erreurs transitoires `5xx` ne sont pas mémorisées comme succès ;
- l’insertion du receipt est sûre en concurrence.

Le receipt n’est consulté ou créé qu’après validation de la signature, de la route, du compte,
de l’environnement, de l’installation et du droit courant de l’acteur. Les échecs de signature,
de route, de binding ou d’accès — ainsi que les commandes illisibles avant résolution du tenant —
restent hors du périmètre d’idempotence et ne peuvent jamais servir à rejouer une réponse d’un
autre contexte.

## 11. Données minimales

Tables conceptuelles :

- tenants et installations ;
- utilisateurs observés et politiques d’accès ;
- demandes et décisions ;
- exécutions et tentatives ;
- receipts webhook ;
- alertes externes ;
- audit append-only ;
- `api_mutation_receipts` ;
- checkpoints de réconciliation ;
- jobs pg-boss dans son schéma dédié.

Contraintes attendues :

- identifiants Stripe associés au tenant et à l’environnement ;
- une décision finale gagnante par demande ;
- un guard financier actif par cible et demande ;
- premier Refund ID immuable ;
- montant strictement positif ;
- unicité des receipts Event et mutation ;
- audit non modifiable par les rôles runtime.

## 12. Isolation et cryptographie

PostgreSQL applique RLS en mode fail-closed :

- `ENABLE ROW LEVEL SECURITY` et `FORCE ROW LEVEL SECURITY` ;
- web et worker sans `BYPASSRLS` ;
- contexte tenant posé comme première instruction d’une transaction ;
- accès hors transaction interdit pour les tables tenantées ;
- tests négatifs croisés tenant A/tenant B ;
- rôle de purge limité, séparé des runtimes.

Justifications et motifs de rejet sont chiffrés avec AES-256-GCM :

- clé versionnée ;
- nonce aléatoire unique ;
- AAD incluant tenant, table, identifiant et champ ;
- anciennes clés de champ disponibles pour déchiffrement durant rotation.

Les preuves utilisent des clés HMAC séparées :

- version active en signature ;
- anciennes versions en vérification seulement ;
- aucune réutilisation d’une clé de chiffrement comme clé HMAC.

Les liens d’export d’audit à courte durée de vie utilisent une troisième clé
de signature indépendante. Cette clé n’est réutilisée ni pour le chiffrement
des champs ni pour les preuves de remboursement.

## 13. Journalisation et audit

Les logs ne contiennent jamais :

- secret ou clé Stripe ;
- signature complète ;
- payload Stripe complet ;
- e-mail, nom, adresse ou donnée de carte ;
- justification ou motif de rejet en clair ;
- valeur chiffrée complète.

Les identifiants opérationnels acceptables sont les UUID internes, identifiants Stripe non secrets, modes, états et codes d’erreur expurgés.

L’audit est append-only et enregistre :

- acteur ;
- tenant et environnement ;
- action ;
- objet interne ;
- état avant/après ;
- timestamp ;
- corrélation ;
- version de politique ;
- empreinte des données sensibles, jamais leur clair.

## 14. Rétention et suppression

Politique pilote :

| Donnée                                        |     Durée |
| --------------------------------------------- | --------: |
| Demandes, décisions, audit, mutation receipts | 365 jours |
| Justification et motifs chiffrés              | 365 jours |
| Receipts webhook minimaux                     |  90 jours |
| Logs opérationnels                            |  30 jours |
| Alertes externes                              | 365 jours |

Après désinstallation :

- installation immédiatement suspendue ;
- aucun nouveau job financier ;
- purge tenant au plus tard trente jours après la désinstallation ;
- un legal hold documenté peut suspendre la purge ;
- la purge conserve uniquement une preuve non personnelle de son exécution.

La procédure détaillée est dans `docs/RETENTION.md`.

## 15. Tests et critères d’acceptation

### 15.1 Domaine

- toutes les transitions et tous les guards ;
- auto-approbation refusée ;
- absence d’approbateur distinct ;
- card-only et refus de `card_present` ;
- montants exacts et devises ;
- preuve HMAC valide, invalide, ancienne et rejouée ;
- classification certaine et ambiguë.

### 15.2 PostgreSQL

- deux créations concurrentes ;
- deux décisions concurrentes ;
- un job unique ;
- mutation receipt concurrent ;
- RLS tenant A/B et fail-closed sans contexte ;
- refus du rôle web sur les exécutions, tentatives, candidats et transitions worker ;
- décision durable, approbateur distinct actif et quorum imposés par la base ;
- désautorisation web autorisée uniquement vers un état moins exécutable ;
- audit immuable ;
- retries ciblés `40001` et `40P01`.

### 15.3 Worker

- crash avant appel ;
- crash après frontière d’effet ;
- crash après réponse avant commit ;
- crash après commit ;
- timeout, `429` et `5xx` ;
- même clé Stripe à chaque retry ;
- aucune clé de contournement ;
- récupération de `executing/not_started` et `executing/absence_proven` avec l’identité persistée ;
- diversion de `executing/possible`, d’une clé divergente ou d’une exécution incomplète.

### 15.4 Webhooks et scans

- doublons et événements hors ordre ;
- webhook avant réponse API ;
- idempotency key absente ;
- événement perdu retrouvé ;
- pagination supérieure à cent ;
- échec intermédiaire puis reprise sans avance du checkpoint ;
- première installation en échec, installation suivante traitée et checkpointée avant le retry global ;
- scan complet sans candidat reprenant l’exécution originale seulement après la borne sûre ;
- refus de prouver l’absence avec une fenêtre incomplète ou antérieure à la borne ;
- rafraîchissement par ID d’un Refund lié antérieur au chevauchement ;
- échec d’une cible liée sans famine des autres cibles ni du scan temporel.

### 15.5 Sandbox

- Refund partiel et total ;
- méthode de test Stripe pour remboursement pending ;
- méthode de test Stripe pour échec de remboursement ;
- deux utilisateurs distincts ;
- remboursement manuel externe ;
- metadata recopiées ;
- désinstallation ;
- séparation test/sandbox/live.

### 15.6 Acceptation du premier cycle

- exactement un Refund ID lié par demande exécutée ;
- aucun appel au mauvais compte ou mode ;
- aucune libération prématurée du guard ;
- aucun secret ou PII dans les logs et rapports ;
- impossibilité totale d’exécuter en live ;
- tous les gates de phase 0 `passed_real`.

## 16. Séquence de livraison

1. Bootstrap, contrat v1.1, ADR et outils locaux.
2. Phase 0 réelle.
3. Fondations PostgreSQL, migrations, RLS et contrats.
4. Workflow demande/décision.
5. Exécution, idempotence et réconciliation.
6. Stripe UI, audit et paramètres.
7. Hardening et suite sandbox complète.

Si la phase 0 vaut `BLOCKED_HUMAN`, seules les fondations sans effet financier peuvent continuer. Si elle vaut `FAIL`, le cœur financier s’arrête.

## 17. Définition de terminé

Une phase est terminée si :

- ses critères sont prouvés par des tests ou des preuves Stripe réelles ;
- le format, lint, types, tests et build concernés passent ;
- aucun secret, donnée réelle, TODO critique ou mock production ne reste ;
- `PLANS.md` reflète l’état réel ;
- le diff a été relu ;
- la documentation opérationnelle est à jour.

Commandes de gate :

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm secrets:check
pnpm audit:prod
pnpm test:sandbox
```

La suite sandbox est un gate séparé : son absence ne peut pas être masquée par les tests locaux.

## 18. Checkpoints ultérieurs

La construction d’une v1 complète n’est autorisée qu’après un pilote séparément approuvé et un signal sur soixante jours :

- au moins trois installations qualifiées ;
- au moins deux tenants avec trois workflows chacun ;
- au moins vingt workflows cumulés ;
- zéro double remboursement ;
- zéro remboursement sur le mauvais compte ou environnement.

## 19. Références officielles

- [Stripe Apps — backend et requêtes signées](https://docs.stripe.com/stripe-apps/build-backend)
- [Stripe Apps — permissions](https://docs.stripe.com/stripe-apps/reference/permissions)
- [Stripe Dashboard — rôles utilisateurs](https://docs.stripe.com/get-started/account/teams/roles)
- [Stripe API — créer un Refund](https://docs.stripe.com/api/refunds/create)
- [Stripe API — lister les Refunds](https://docs.stripe.com/api/refunds/list)
- [Stripe API — objet Event](https://docs.stripe.com/api/events/object)
- [Stripe — signatures webhook](https://docs.stripe.com/webhooks/signature)
- [Stripe — clés API et moindre privilège](https://docs.stripe.com/keys-best-practices)

Les comportements sensibles doivent être revalidés contre la documentation Stripe correspondant à la version verrouillée et, lorsque possible, par un essai réel en sandbox.
