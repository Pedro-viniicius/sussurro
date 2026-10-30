# envs/staging

Vazio na v1 (infra.md §2: local + CI + produção). Os módulos são os mesmos da produção: para criar o
staging, copie `envs/prod`, troque `environment = "staging"`, use outra chave de state
(`staging/terraform.tfstate`) e escolha o porte `enxuto`. Gatilhos: usuários reais com migration
arriscada, uma segunda pessoa na equipe ou teste de carga.
