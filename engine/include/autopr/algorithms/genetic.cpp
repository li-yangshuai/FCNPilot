#include "genetic.h"
#include <algorithm>
#include <cmath>
#include <set>
#include <stdexcept>

namespace fcngraph {
GeneticAlgorithm::GeneticAlgorithm(Parse& parse, GridChessboard& board, Astar& router, GeneticOptions options)
    : parse_(parse), board_(board), router_(router), options_(options), rng_(options.seed) {
    if (options.population < 2 || options.population > 256 || !options.generations ||
        options.generations > 10000 || !std::isfinite(options.budget_seconds) || options.budget_seconds <= 0)
        throw std::invalid_argument("population must be 2..256, generations 1..10000, budget positive");
    // Enumerate constructed cells, avoiding the legacy inclusive-upper-bound
    // randomPosition() mismatch and rejection sampling on a full board.
    for (const auto& cell : board.getGridMap()) sites_.push_back(cell.first);
    std::sort(sites_.begin(), sites_.end());
    if (parse.getEffectiveNodes().empty() || parse.getEffectiveNodes().size() > sites_.size())
        throw std::invalid_argument("clock grid cannot hold all effective nodes");
}

Individual GeneticAlgorithm::randomIndividual(std::size_t index) {
    auto sites = sites_;
    // A compact seed portfolio reduces the search space without fixing a
    // placement or changing the regular template. Every gene stays distinct.
    if (index % 2 == 0) {
        std::stable_sort(sites.begin(), sites.end(), [](position a, position b) {
            return std::make_tuple(std::max(a.first,a.second), a.first+a.second, a) <
                   std::make_tuple(std::max(b.first,b.second), b.first+b.second, b);
        });
        sites.resize(std::min(sites.size(), std::max<std::size_t>(parse_.getEffectiveNodes().size()*3, 16)));
    }
    std::shuffle(sites.begin(), sites.end(), rng_);
    Individual individual;
    std::size_t i = 0;
    for (auto node : parse_.getEffectiveNodes()) individual.nodeindex_pos[node] = sites[i++];
    return individual;
}

void GeneticAlgorithm::repair(Individual& individual) {
    std::set<position> occupied;
    std::vector<unsigned int> duplicates;
    for (auto [id,p] : individual.nodeindex_pos) if (!occupied.insert(p).second) duplicates.push_back(id);
    std::vector<position> free;
    for (auto p : sites_) if (!occupied.count(p)) free.push_back(p);
    std::shuffle(free.begin(), free.end(), rng_);
    for (std::size_t i=0; i<duplicates.size(); ++i) individual.nodeindex_pos[duplicates[i]]=free.at(i);
}

void GeneticAlgorithm::mutate(Individual& individual) {
    if (individual.nodeindex_pos.empty()) return;
    auto chosen=individual.nodeindex_pos.begin();
    std::advance(chosen, rng_()%individual.nodeindex_pos.size());
    std::set<position> occupied;
    for (auto [id,p] : individual.nodeindex_pos) if (id!=chosen->first) occupied.insert(p);
    std::vector<position> choices;
    const bool local = rng_()%4 != 0;
    for (auto p : sites_) if (!occupied.count(p) && p != chosen->second &&
        (!local || std::abs(static_cast<long long>(p.first)-chosen->second.first) +
                   std::abs(static_cast<long long>(p.second)-chosen->second.second) <= 2)) choices.push_back(p);
    if (!choices.empty()) chosen->second = choices[rng_()%choices.size()];
    else if (individual.nodeindex_pos.size()>1) {
        auto other=individual.nodeindex_pos.begin();
        std::advance(other, rng_()%individual.nodeindex_pos.size());
        std::swap(chosen->second, other->second);
    }
}

bool GeneticAlgorithm::gaRun() {
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::duration_cast<std::chrono::steady_clock::duration>(
        std::chrono::duration<double>(options_.budget_seconds));
    std::vector<Individual> population;
    for (std::size_t i=0;i<options_.population;++i) population.push_back(randomIndividual(i));
    for (std::size_t generation=0;generation<options_.generations;++generation) {
        for (auto& candidate : population) {
            if (std::chrono::steady_clock::now()>=deadline) return feasible_>0;
            candidate.computeFitness(parse_,board_,router_,deadline); ++evaluated_;
            if (candidate.evaluation.valid) {
                ++feasible_;
                if (!best_.evaluation.valid || candidate.betterThan(best_)) best_=candidate;
            } else last_error_=candidate.evaluation.error;
        }
        std::stable_sort(population.begin(),population.end(),[](const auto& a,const auto& b){return a.betterThan(b);});
        std::vector<Individual> next;
        next.push_back(best_.evaluation.valid ? best_ : population.front());
        const auto select = [&]() -> const Individual& {
            std::size_t selected = rng_()%population.size();
            for (int i=0;i<3;++i) {const auto other=rng_()%population.size(); if(population[other].betterThan(population[selected])) selected=other;}
            return population[selected];
        };
        while (next.size()<options_.population) {
            if (next.size()%8==0) {next.push_back(randomIndividual(next.size()+generation)); continue;}
            Individual child=select();
            const auto& donor=select();
            for (auto& gene:child.nodeindex_pos) if(rng_()%2) gene.second=donor.nodeindex_pos.at(gene.first);
            repair(child); mutate(child); next.push_back(std::move(child));
        }
        population=std::move(next);
    }
    return feasible_>0;
}
}
