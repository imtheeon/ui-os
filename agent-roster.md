# U-I-OS Ruflo Agent Roster
**Total: 201 agents + 1 infrastructure connector (BigQuery)**
Legend: ✅ Built | 🔄 Queued (batch files written, not yet run) | 🆕 New (batch 32)

---

## Foundation — Batches 01–08 (Migrations 0001–0056) ✅
*Core pipeline, document, data, and output agents — all built and tested*

| # | Agent Role | What it does |
|---|-----------|-------------|
| 1 | `anomaly_detector` | Detects statistical anomalies in financial data |
| 2 | `categorizer` | Categorizes transactions and line items |
| 3 | `data_cleaner` | Cleans and normalizes raw data |
| 4 | `data_merger` | Merges and deduplicates data sources |
| 5 | `unit_normalizer` | Normalizes units, scales, and formats |
| 6 | `reconciler` | Reconciles cross-source discrepancies |
| 7 | `invoice_matcher` | Matches invoices to POs and payments |
| 8 | `cash_flow_agent` | Cash flow analysis |
| 9 | `tax_categorizer` | Categorizes transactions for tax purposes |
| 10 | `duplicate_detector` | Detects duplicate records and entries |
| 11 | `budget_analyst` | Budget vs. actual analysis |
| 12 | `inventory_tracker` | Tracks inventory levels and movements |
| 13 | `reorder_flagger` | Flags items needing reorder |
| 14 | `supplier_analyst` | Supplier performance analysis |
| 15 | `po_agent` | Purchase order analysis |
| 16 | `trend_detector` | Detects trends across time series |
| 17 | `period_comparator` | Compares performance across periods |
| 18 | `exec_summarizer` | Executive-level narrative summaries |
| 19 | `forecaster` | General financial forecasting |
| 20 | `report_generator` | Generates structured reports |
| 21 | `data_quality` | Data quality scoring |
| 22 | `compliance_agent` | Regulatory compliance checks |
| 23 | `vendor_risk` | Vendor risk assessment |
| 24 | `onboarding_agent` | New client onboarding analysis |
| 25 | `clarification_agent` | Identifies data ambiguities needing clarification |
| 26 | `multi_period` | Multi-period financial analysis |
| 27 | `audit_summarizer` | Audit trail summarization |
| 28 | `code_reviewer` | Reviews generated code/SQL |
| 29 | `code_tester` | Tests generated logic |
| 30 | `sql_analyst` | SQL query analysis and optimization |
| 31 | `validator` | Validates data against rules |
| 32 | `health_scorer` | Financial health scoring |
| 33 | `email_drafter` | Drafts client-facing communications |
| 34 | `recommender` | Action recommendation engine |
| 35 | `pattern_memory` | Identifies recurring patterns across runs |
| 36 | `alert_agent` | Configures and fires financial alerts |
| 37 | `client_reporter` | Client-ready report generation |
| 38 | `narrator` | Plain-language data narration |
| 39 | `meeting_prepper` | Prepares meeting materials and talking points |
| 40 | `board_deck_builder` | Board presentation assembly |
| 41 | `viz_recommender` | Recommends chart types and visualizations |
| 42 | `chart_config_agent` | Generates chart configuration specs |
| 43 | `kpi_card_agent` | Builds KPI card layouts |
| 44 | `dashboard_spec_agent` | Specifies full dashboard layouts |
| 45 | `saas_metrics_agent` | Core SaaS metrics (MRR, ARR, churn) |
| 46 | `burn_rate_agent` | Burn rate and runway analysis |
| 47 | `cohort_agent` | Cohort-based retention analysis |
| 48 | `ar_aging_agent` | Accounts receivable aging buckets |
| 49 | `ap_agent` | Accounts payable analysis |
| 50 | `bank_recon_agent` | Bank reconciliation |

---

## Batch 09 — Core Financial Ratios (Migrations 0057–0062) ✅

| # | Agent Role | Route | What it does |
|---|-----------|-------|-------------|
| 51 | `ratio_analysis_agent` | FINANCIAL | Liquidity, leverage, efficiency, profitability ratios |
| 52 | `profitability_agent` | FINANCIAL | Gross/net/EBITDA margin analysis |
| 53 | `working_capital_agent` | FINANCIAL | DSO, DPO, DIO, CCC calculation |
| 54 | `break_even_agent` | FINANCIAL | Break-even analysis and contribution margin |
| 55 | `cogs_analysis_agent` | FINANCIAL | COGS breakdown and cost driver analysis |
| 56 | `revenue_recognition_agent` | FINANCIAL | ASC 606 / IFRS 15 revenue recognition |

---

## Batch 10 — Customer & Sales Analytics (Migrations 0063–0068) ✅

| # | Agent Role | Route | What it does |
|---|-----------|-------|-------------|
| 57 | `churn_risk_agent` | FINANCIAL | Customer churn risk scoring and prediction |
| 58 | `customer_segmentation_agent` | BOTH | Customer segmentation and profiling |
| 59 | `sales_pipeline_agent` | FINANCIAL | Sales pipeline analysis and conversion |
| 60 | `pricing_optimization_agent` | FINANCIAL | Pricing analysis and optimization |
| 61 | `contract_analysis_agent` | BOTH | Contract term extraction and risk |
| 62 | `marketing_roi_agent` | FINANCIAL | Marketing spend ROI analysis |

---

## Batch 11 — Risk & Controls (Migrations 0069–0073) ✅

| # | Agent Role | Route | What it does |
|---|-----------|-------|-------------|
| 63 | `fraud_detection_agent` | BOTH | Fraud signal detection with Benford analysis |
| 64 | `concentration_risk_agent` | BOTH | Revenue and customer concentration risk |
| 65 | `scenario_agent` | BOTH | Scenario modeling (bear/base/bull) |
| 66 | `liquidity_risk_agent` | FINANCIAL | Liquidity risk assessment |
| 67 | `covenant_tracking_agent` | FINANCIAL | Debt covenant monitoring and headroom |

---

## Batch 12 — Pipeline Intelligence (Migrations 0074–0079) ✅

| # | Agent Role | Route | What it does |
|---|-----------|-------|-------------|
| 68 | `document_classifier` | BOTH (EARLY) | First agent — classifies incoming document type |
| 69 | `schema_evolution_agent` | BOTH (EARLY) | Detects schema changes across payloads |
| 70 | `kpi_extractor` | BOTH | Extracts KPIs from any document |
| 71 | `insight_synthesis_agent` | BOTH (LATE) | Synthesizes insights across agent outputs |
| 72 | `conflict_detection_agent` | BOTH (LATE) | Detects conflicting findings across agents |
| 73 | `action_priority_agent` | BOTH (LAST) | Prioritizes recommended actions |

---

## Batch 13 — Data Governance (Migrations 0080–0085) ✅

| # | Agent Role | Route | What it does |
|---|-----------|-------|-------------|
| 74 | `column_profiler` | BOTH | Profiles column types, ranges, distributions |
| 75 | `data_dictionary_agent` | BOTH | Generates data dictionaries from schemas |
| 76 | `missing_data_agent` | BOTH | Analyzes missing data patterns |
| 77 | `data_privacy_agent` | BOTH | Detects PII and privacy risks |
| 78 | `transaction_classifier` | BOTH | Classifies transaction types and categories |
| 79 | `expense_policy_agent` | BOTH | Flags expense policy violations |

---

## Batch 14 — HR & Operations (Migrations 0086–0091) ✅

| # | Agent Role | Route | What it does |
|---|-----------|-------|-------------|
| 80 | `subscription_tracker` | FINANCIAL | Subscription and recurring revenue tracking |
| 81 | `headcount_analytics_agent` | BOTH | Headcount metrics and workforce analytics |
| 82 | `commission_calculator` | FINANCIAL | Sales commission calculation and analysis |
| 83 | `productivity_agent` | BOTH | Revenue/output per employee productivity |
| 84 | `overtime_analysis_agent` | BOTH | Overtime cost and pattern analysis |
| 85 | `growth_rate_agent` | BOTH | Growth rate calculation across metrics |

---

## Batch 15 — Valuation & Equity (Migrations 0092–0097) ✅

| # | Agent Role | Route | What it does |
|---|-----------|-------|-------------|
| 86 | `outlier_explanation_agent` | BOTH | Explains statistical outliers in context |
| 87 | `time_series_decomp_agent` | BOTH | Time series decomposition (trend/seasonal) |
| 88 | `failure_risk_agent` | BOTH | Predicts operational failure and business risk |
| 89 | `unit_economics_agent` | FINANCIAL | Unit economics (CAC, LTV, margin per unit) |
| 90 | `valuation_agent` | FINANCIAL | Business valuation modeling |
| 91 | `cap_table_agent` | FINANCIAL | Cap table analysis and ownership |

---

## Batch 16 — FP&A Core (Migrations 0098–0103) ✅

| # | Agent Role | Route | What it does |
|---|-----------|-------|-------------|
| 92 | `lease_analysis_agent` | FINANCIAL | ASC 842 lease accounting analysis |
| 93 | `asset_register_agent` | FINANCIAL | Fixed asset register and depreciation |
| 94 | `price_volume_mix_agent` | FINANCIAL | PVM revenue variance decomposition |
| 95 | `bridge_analysis_agent` | FINANCIAL | Period-over-period bridge analysis |
| 96 | `run_rate_agent` | FINANCIAL | Run rate and annualization |
| 97 | `spend_analysis_agent` | BOTH | Spend categorization and analysis |

---

## Batch 17 — AR/AP & Credit (Migrations 0104–0109) ✅

| # | Agent Role | Route | What it does |
|---|-----------|-------|-------------|
| 98 | `discount_analysis_agent` | FINANCIAL | Discount and allowance analysis |
| 99 | `maverick_spend_agent` | FINANCIAL | Off-contract / maverick spending detection |
| 100 | `collections_priority_agent` | FINANCIAL | AR collections prioritization |
| 101 | `bad_debt_provision_agent` | FINANCIAL | Bad debt reserve calculation |
| 102 | `credit_scoring_agent` | FINANCIAL | Customer credit risk scoring |
| 103 | `fx_exposure_agent` | FINANCIAL | FX exposure and currency risk |

---

## Batch 18 — Strategy & Board (Migrations 0110–0116) ✅

| # | Agent Role | Route | What it does |
|---|-----------|-------|-------------|
| 104 | `investor_memo_agent` | FINANCIAL | Investor memo and narrative drafting |
| 105 | `okr_tracker_agent` | BOTH | OKR progress tracking and analysis |
| 106 | `swot_agent` | BOTH | SWOT analysis from financial/operational data |
| 107 | `query_builder_agent` | BOTH | Natural language to structured query |
| 108 | `esg_reporting_agent` | BOTH | ESG metrics and reporting |
| 109 | `seasonality_agent` | BOTH | Seasonality detection and adjustment |
| 110 | `benchmark_agent` | BOTH | Industry benchmarking |

---

## Batch 19 — Industry Vertical Specialists (Migrations 0117–0125) 🔄

| # | Agent Role | Route | What it does |
|---|-----------|-------|-------------|
| 111 | `consolidation_agent` | FINANCIAL | Multi-entity financial consolidation |
| 112 | `ecommerce_agent` | BOTH | E-commerce metrics (GMV, AOV, CAC) |
| 113 | `professional_services_agent` | FINANCIAL | Services firm metrics (utilization, realization) |
| 114 | `nonprofit_agent` | FINANCIAL | Nonprofit financial analysis (fund accounting) |
| 115 | `healthcare_agent` | FINANCIAL | Healthcare revenue cycle and metrics |
| 116 | `legal_billing_agent` | FINANCIAL | Legal firm billing and matter profitability |
| 117 | `hospitality_agent` | BOTH | Hospitality metrics (RevPAR, ADR, occupancy) |
| 118 | `retail_agent` | BOTH | Retail metrics (comp store, inventory turns) |
| 119 | `construction_agent` | FINANCIAL | Construction project cost and WIP |

---

## Batch 20 — SaaS & Startup Finance (Migrations 0126–0131) 🔄

| # | Agent Role | Route | What it does |
|---|-----------|-------|-------------|
| 120 | `saas_metrics_agent` | BOTH | Enhanced SaaS metrics (NRR, GRR, quick ratio) |
| 121 | `burn_rate_agent` | BOTH | Enhanced burn rate and runway analysis |
| 122 | `revenue_quality_agent` | BOTH | Revenue quality and sustainability scoring |
| 123 | `cohort_analysis_agent` | BOTH | Enhanced cohort-based analytics |
| 124 | `variance_analysis_agent` | BOTH | Budget vs. actual variance deep-dive |
| 125 | `cash_flow_forecast_agent` | FINANCIAL | 13-week cash flow forecasting |

---

## Batch 21 — FP&A & Risk (Migrations 0132–0137) 🔄

| # | Agent Role | Route | What it does |
|---|-----------|-------|-------------|
| 126 | `expense_forecast_agent` | FINANCIAL | Expense forecasting by category |
| 127 | `headcount_analysis_agent` | BOTH | Headcount cost and efficiency analysis |
| 128 | `debt_covenant_agent` | FINANCIAL | Debt covenant compliance analysis |
| 129 | `tax_provision_agent` | FINANCIAL | Tax provision calculation and analysis |
| 130 | `collections_agent` | FINANCIAL | Collections management and AR acceleration |
| 131 | `competitive_benchmarking_agent` | BOTH | Competitive financial benchmarking |

---

## Batch 22 — Data Quality, Output & Meta (Migrations 0138–0143) 🔄

| # | Agent Role | Route | What it does |
|---|-----------|-------|-------------|
| 132 | `data_quality_agent` | BOTH | Enhanced data quality assessment |
| 133 | `schema_detection_agent` | BOTH | Schema detection and mapping |
| 134 | `board_narrative_agent` | BOTH | Board-ready narrative generation |
| 135 | `investor_update_agent` | BOTH | Investor update drafting |
| 136 | `orchestrator_agent` | BOTH | Agent orchestration and routing |
| 137 | `confidence_reviewer_agent` | BOTH | Reviews agent output confidence levels |

---

## Batch 23 — Data Transformation (Migrations 0144–0149) 🔄

| # | Agent Role | Route | What it does |
|---|-----------|-------|-------------|
| 138 | `data_reshape_agent` | BOTH | Reshapes wide/long data formats |
| 139 | `date_normalization_agent` | BOTH | Normalizes date formats and timezones |
| 140 | `string_normalization_agent` | BOTH | Normalizes strings, names, categories |
| 141 | `currency_normalization_agent` | BOTH | Normalizes currencies and exchange rates |
| 142 | `join_quality_agent` | BOTH | Assesses join quality between datasets |
| 143 | `data_validation_rules_agent` | BOTH | Applies and generates data validation rules |

---

## Batch 24 — EDA & Statistics (Migrations 0150–0155) 🔄

| # | Agent Role | Route | What it does |
|---|-----------|-------|-------------|
| 144 | `distribution_agent` | BOTH | Statistical distribution analysis |
| 145 | `correlation_agent` | BOTH | Correlation analysis between variables |
| 146 | `regression_agent` | BOTH | Linear and logistic regression analysis |
| 147 | `hypothesis_testing_agent` | BOTH | Statistical hypothesis testing |
| 148 | `pareto_agent` | BOTH | Pareto (80/20) analysis |
| 149 | `clustering_agent` | BOTH | Customer/data clustering |

---

## Batch 25 — Product & Customer Analytics (Migrations 0156–0161) 🔄

| # | Agent Role | Route | What it does |
|---|-----------|-------|-------------|
| 150 | `funnel_analysis_agent` | BOTH | Conversion funnel analysis |
| 151 | `retention_analysis_agent` | BOTH | Customer retention and cohort curves |
| 152 | `ab_test_agent` | BOTH | A/B test statistical analysis |
| 153 | `nps_analysis_agent` | BOTH | NPS analysis and driver identification |
| 154 | `feature_adoption_agent` | BOTH | Feature usage and adoption metrics |
| 155 | `customer_health_score_agent` | BOTH | Customer health scoring |

---

## Batch 26 — Sales & Revenue Analytics (Migrations 0162–0167) 🔄

| # | Agent Role | Route | What it does |
|---|-----------|-------|-------------|
| 156 | `quota_attainment_agent` | FINANCIAL | Sales quota attainment analysis |
| 157 | `win_loss_agent` | FINANCIAL | Win/loss analysis |
| 158 | `forecast_accuracy_agent` | FINANCIAL | Sales forecast accuracy measurement |
| 159 | `attribution_agent` | FINANCIAL | Marketing and revenue attribution |
| 160 | `price_elasticity_agent` | FINANCIAL | Price elasticity modeling |
| 161 | `expansion_opportunity_agent` | BOTH | Expansion and upsell opportunity scoring |

---

## Batch 27 — People Analytics & Planning (Migrations 0168–0173) 🔄

| # | Agent Role | Route | What it does |
|---|-----------|-------|-------------|
| 162 | `attrition_analysis_agent` | BOTH | Employee attrition analysis and prediction |
| 163 | `headcount_planning_agent` | BOTH | Headcount planning and forecasting |
| 164 | `demand_forecasting_agent` | BOTH | Demand forecasting |
| 165 | `capacity_planning_agent` | BOTH | Capacity planning analysis |
| 166 | `sla_analysis_agent` | BOTH | SLA compliance analysis |
| 167 | `compensation_analysis_agent` | FINANCIAL | Compensation benchmarking and analysis |

---

## Batch 28 — Advanced Analytics (Migrations 0174–0179) 🔄

| # | Agent Role | Route | What it does |
|---|-----------|-------|-------------|
| 168 | `metric_tree_agent` | BOTH | Builds metric trees and driver trees |
| 169 | `text_analytics_agent` | BOTH | Text and sentiment analytics |
| 170 | `data_freshness_agent` | BOTH | Data freshness and staleness assessment |
| 171 | `narrative_diff_agent` | BOTH | Diffs narrative across periods |
| 172 | `alert_threshold_agent` | BOTH | Alert threshold configuration |
| 173 | `data_annotation_agent` | BOTH | Data annotation and labeling |

---

## Batch 29 — Financial Modeling Integrity (Migrations 0180–0185) 🔄

| # | Agent Role | Route | What it does |
|---|-----------|-------|-------------|
| 174 | `financial_statement_normalizer_agent` | FINANCIAL | Normalizes financial statements to standard format |
| 175 | `three_statement_model_agent` | FINANCIAL | Builds integrated 3-statement model |
| 176 | `quality_of_earnings_agent` | FINANCIAL | QoE analysis (recurring vs. non-recurring) |
| 177 | `deferred_revenue_agent` | FINANCIAL | Deferred revenue waterfall analysis |
| 178 | `earnings_quality_agent` | FINANCIAL | Accruals, cash conversion, earnings quality |
| 179 | `intercompany_elimination_agent` | FINANCIAL | Intercompany transaction elimination |

---

## Batch 30 — M&A & Advanced Financial (Migrations 0186–0191) 🔄

| # | Agent Role | Route | What it does |
|---|-----------|-------|-------------|
| 180 | `stock_based_compensation_agent` | FINANCIAL | SBC expense analysis and impact |
| 181 | `gaap_compliance_agent` | FINANCIAL | GAAP compliance assessment |
| 182 | `tax_rate_reconciliation_agent` | FINANCIAL | Effective tax rate reconciliation |
| 183 | `due_diligence_checklist_agent` | BOTH | M&A due diligence checklist generation |
| 184 | `market_sizing_agent` | BOTH | TAM/SAM/SOM market sizing |
| 185 | `invoice_extraction_agent` | BOTH | Invoice data extraction and structuring |

---

## Batch 31 — BigQuery Integration (Migrations 0192–0193) 🔄

| # | Item | Type | What it does |
|---|------|------|-------------|
| — | `BigQuery Connector` | Infrastructure | Encrypted credential storage, dataset/table discovery, bounded query execution (10k row cap) |
| 186 | `bigquery_query_agent` | BOTH | Translates natural language to BigQuery SQL; only SELECT; executor substitutes real project_id |

---

## Batch 32 — Working Capital & Investor Intelligence (Migrations 0194–0203) 🆕

| # | Agent Role | Route | Model | What it does |
|---|-----------|-------|-------|-------------|
| 187 | `cash_positioning_agent` | FINANCIAL | Haiku | Daily/weekly liquidity snapshot — 7-day and 30-day cash projections |
| 188 | `debt_schedule_agent` | FINANCIAL | Sonnet | Loan amortization, DSCR, covenant headroom, refinancing risk |
| 189 | `equity_waterfall_agent` | FINANCIAL | Opus | Liquidation preference waterfalls across share classes and exit scenarios |
| 190 | `payroll_analytics_agent` | BOTH | Sonnet | Fully-loaded payroll cost, burden rate, by-department breakdown |
| 191 | `vendor_concentration_agent` | BOTH | Sonnet | Vendor concentration risk, HHI index, single-source dependency |
| 192 | `investor_metrics_agent` | FINANCIAL | Sonnet | Rule of 40, magic number, burn multiple, NRR, LTV:CAC |
| 193 | `clv_agent` | BOTH | Sonnet | Customer lifetime value, LTV:CAC by segment |
| 194 | `payment_terms_agent` | FINANCIAL | Haiku | DSO/DPO analysis, early payment discount opportunities |
| 195 | `sensitivity_analysis_agent` | BOTH | Sonnet | Tornado charts, scenario matrix, break-even by input variable |
| 196 | `working_capital_optimization_agent` | FINANCIAL | Sonnet | Actionable CCC improvement recommendations with cash impact |

---

## Summary

| Phase | Batches | Agents | Status |
|-------|---------|--------|--------|
| Foundation | 01–08 | 50 | ✅ Built |
| Core analytics | 09–18 | 60 | ✅ Built |
| Vertical + advanced | 19–31 | 91 + BigQuery | 🔄 Queued |
| New additions | 32 | 10 | 🆕 Written |
| **Total** | **32 batches** | **201 agents** | |
